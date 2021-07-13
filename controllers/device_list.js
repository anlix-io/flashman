const Validator = require('../public/javascripts/device_validator');
const DevicesAPI = require('./external-genieacs/devices-api');
const TasksAPI = require('./external-genieacs/tasks-api');
const messaging = require('./messaging');
const DeviceModel = require('../models/device');
const User = require('../models/user');
const DeviceVersion = require('../models/device_version');
const Config = require('../models/config');
const Role = require('../models/role');
const firmware = require('./firmware');
const mqtt = require('../mqtts');
const sio = require('../sio');
const deviceHandlers = require('./handlers/devices');
const meshHandlers = require('./handlers/mesh');
const util = require('./handlers/util');
const controlApi = require('./external-api/control');
const acsDeviceInfo = require('./acs_device_info.js');
const updateController = require('./update_flashman.js');
const {Parser, transforms: {unwind, flatten}} = require('json2csv');
const crypto = require('crypto');

let deviceListController = {};

const fs = require('fs');
const unzipper = require('unzipper');
const request = require('request');
const md5File = require('md5-file');
const requestPromise = require('request-promise-native');
const imageReleasesDir = process.env.FLM_IMG_RELEASE_DIR;

const stockFirmwareLink = 'https://cloud.anlix.io/s/KMBwfD7rcMNAZ3n/download?path=/&files=';

const intToWeekDayStr = function(day) {
  if (day === 0) return 'Domingo';
  if (day === 1) return 'Segunda';
  if (day === 2) return 'Terça';
  if (day === 3) return 'Quarta';
  if (day === 4) return 'Quinta';
  if (day === 5) return 'Sexta';
  if (day === 6) return 'Sábado';
  return '';
};

// if allSettled is not defined in Promise, we define it here.
if (Promise.allSettled === undefined) {
  Promise.allSettled = function allSettled(promises) {
    let wrappedPromises = promises.map((p) => Promise.resolve(p)
      .then(
        (val) => ({status: 'fulfilled', value: val}),
        (err) => ({status: 'rejected', reason: err})));
    return Promise.all(wrappedPromises);
  };
}

const escapeRegExp = function(string) {
  // $& means the whole matched string
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

deviceListController.getReleases = async function(role,
                                                  isSuperuser,
                                                  modelAsArray=false) {
  let filenames = fs.readdirSync(imageReleasesDir);
  let releases = await firmware.getReleases(filenames, role,
                                            isSuperuser, modelAsArray);
  return releases;
};

const getOnlineCount = async function(query, mqttClients, lastHour,
 tr069Times) {
  let status = {};
  status.onlinenum = 0;
  status.recoverynum = 0;
  status.offlinenum = 0;

  // the queries for each status count. they each countain a query to select
  // each router type, flashbox or onu/tr069, inside the $or array.
  let onlineQuery = {
    $or: [ // 1st: flashbox devices; 2nd: tr069 devices.
      {_id: {$in: mqttClients}},
      {last_contact: {$gte: tr069Times.recovery}},
    ],
  };
  let recoveryQuery = {
    $or: [ // 1st: flashbox devices; 2nd: tr069 devices.
      {_id: {$nin: mqttClients}, last_contact: {$gte: lastHour.getTime()}},
      {last_contact: {$lt: tr069Times.recovery, $gte: tr069Times.offline}},
    ],
  };
  let offlineQuery = {
    $or: [ // 1st: flashbox devices; 2nd: tr069 devices.
      {_id: {$nin: mqttClients}, last_contact: {$lt: lastHour.getTime()}},
      {last_contact: {$lt: tr069Times.offline}},
    ],
  };
  let queries = [onlineQuery, recoveryQuery, offlineQuery];
  // adding the parameter that will defined the router type for each count.
  for (let i = 0; i < queries.length; i++) {
    // a selector for flashbox devices.
    queries[i].$or[0].use_tr069 = {$ne: true};
    queries[i].$or[1].use_tr069 = true; // a selector for tr069 devices.
  }

  // issue the count for each status and the mesh count in parallel.
  let counts = await Promise.all([
    DeviceModel.countDocuments({$and: [onlineQuery, query]}).exec(),
    DeviceModel.countDocuments({$and: [recoveryQuery, query]}).exec(),
    DeviceModel.countDocuments({$and: [offlineQuery, query]}).exec(),
    getOnlineCountMesh(query, lastHour),
  ]);
  // adding each count to their respective status.
  status.onlinenum += counts[0]+counts[3].onlinenum;
  status.recoverynum += counts[1]+counts[3].recoverynum;
  status.offlinenum += counts[2]+counts[3].offlinenum;

  // add total
  status.totalnum = status.offlinenum+status.recoverynum+status.onlinenum;
  return status; // resolve with the counts.
};

const getOnlineCountMesh = function(query, lastHour) {
  return new Promise((resolve, reject)=> {
    let meshQuery = {$and: [{mesh_mode: {$gt: 0}}, query]};
    let status = {onlinenum: 0, recoverynum: 0, offlinenum: 0};
    lastHour = lastHour.getTime();
    let options = {'_id': 1, 'mesh_master': 1, 'mesh_slaves': 1};

    const mqttClients = Object.values(mqtt.unifiedClientsMap)
    .reduce((acc, curr) => {
      return acc.concat(Object.keys(curr));
    }, []);

    DeviceModel.find(meshQuery, options, function(err, devices) {
      if (!err) {
        meshHandlers.enhanceSearchResult(devices).then((extra)=>{
          extra.forEach((e)=>{
            if (mqttClients.includes(e._id)) status.onlinenum += 1;
            else if (e.last_contact >= lastHour) status.recoverynum += 1;
            else status.offlinenum += 1;
          });
          return resolve(status);
        });
      } else {
        return reject(err);
      }
    });
  });
};

// getting values for inform configurations for tr069 from Config.
const getOnlyTR069Configs = async function(errormsg) {
  let configsWithTr069 = await Config.findOne({is_default: true}, 'tr069')
    .exec().catch((err) => err); // in case of error, return error in await.
  // it's very unlikely that we will incur in any error but,
  if (configsWithTr069.constructor === Error) { // if we returned an error.
    // print error message.
    console.log(errormsg, '\nUsing default values for tr069 config.');
    return { // build a default configuration.
      inform_interval: 10*60*1000,
      offline_threshold: 1,
      recovery_threshold: 3,
    };
  } else { // if no error.
    return configsWithTr069.tr069; // get only tr069 config inside the document.
  }
};

// Main page
deviceListController.index = function(req, res) {
  let indexContent = {};
  let elementsPerPage = 10;

  if (req.user.maxElementsPerPage) {
    elementsPerPage = req.user.maxElementsPerPage;
  }
  indexContent.username = req.user.name;
  indexContent.elementsperpage = elementsPerPage;
  indexContent.visiblecolumnsonpage = req.user.visibleColumnsOnPage;

  // Check Flashman automatic update availability
  if (typeof process.env.FLM_DISABLE_AUTO_UPDATE !== 'undefined' && (
             process.env.FLM_DISABLE_AUTO_UPDATE === 'true' ||
             process.env.FLM_DISABLE_AUTO_UPDATE === true)
  ) {
    indexContent.disableAutoUpdate = true;
  } else {
    indexContent.disableAutoUpdate = false;
  }

  // Check Flashman data collecting availability
  if (typeof process.env.FLM_ENABLE_DATA_COLLECTING !== 'undefined' && (
             process.env.FLM_ENABLE_DATA_COLLECTING === 'true' ||
             process.env.FLM_ENABLE_DATA_COLLECTING === true)
  ) {
    indexContent.enable_data_collecting = true;
  } else {
    indexContent.enable_data_collecting = false;
  }

  User.findOne({name: req.user.name}, function(err, user) {
    if (err || !user) {
      indexContent.superuser = false;
    } else {
      indexContent.superuser = user.is_superuser;
    }

    Config.findOne({is_default: true}, function(err, matchedConfig) {
      if (err || !matchedConfig) {
        indexContent.update = false;
      } else {
        indexContent.update = matchedConfig.hasUpdate;
        indexContent.majorUpdate = matchedConfig.hasMajorUpdate;
        indexContent.minlengthpasspppoe = matchedConfig.pppoePassLength;
        indexContent.update_schedule = {
          is_active: matchedConfig.device_update_schedule.is_active,
          device_total: matchedConfig.device_update_schedule.device_count,
        };
        if (matchedConfig.device_update_schedule.device_count > 0) {
          // Has a previous configuration saved
          let params = matchedConfig.device_update_schedule;
          let rule = params.rule;
          indexContent.update_schedule['is_aborted'] = params.is_aborted;
          indexContent.update_schedule['date'] = params.date;
          indexContent.update_schedule['use_csv'] = params.used_csv;
          indexContent.update_schedule['use_search'] = params.used_search;
          indexContent.update_schedule['use_time'] = params.used_time_range;
          indexContent.update_schedule['time_ranges'] =
            params.allowed_time_ranges.map((r)=>{
              return {
                start_day: intToWeekDayStr(r.start_day),
                end_day: intToWeekDayStr(r.end_day),
                start_time: r.start_time,
                end_time: r.end_time,
              };
            });
          indexContent.update_schedule['release'] = params.rule.release;
          let todo = rule.to_do_devices.length;
          rule.to_do_devices.forEach((d)=>{
            if (d.slave_count > 0) {
              todo += d.slave_count;
            }
          });
          let inProgress = rule.in_progress_devices.length;
          rule.in_progress_devices.forEach((d)=>{
            if (d.slave_count > 0) {
              inProgress += d.slave_count;
            }
          });
          let doneList = rule.done_devices.filter((d)=>d.state==='ok');
          let done = doneList.length;
          doneList.forEach((d)=>{
            if (d.slave_count > 0) {
              done += d.slave_count;
            }
          });
          let errorList = rule.done_devices.filter((d)=>d.state!=='ok');
          let derror = errorList.length;
          errorList.forEach((d)=>{
            if (d.slave_count > 0) {
              derror += d.slave_count;
            }
          });
          indexContent.update_schedule['device_doing'] =
            rule.in_progress_devices.length;
          indexContent.update_schedule['device_to_do'] = todo + inProgress;
          indexContent.update_schedule['device_done'] = done;
          indexContent.update_schedule['device_error'] = derror;
          indexContent.update_schedule['device_total'] =
            todo + inProgress + done + derror;
        }
      }

      // Filter data using user permissions
      if (req.user.is_superuser) {
        return res.render('index', indexContent);
      } else {
        Role.findOne({name: req.user.role}, function(err, role) {
          if (err) {
            console.log(err);
          }
          indexContent.role = role;
          return res.render('index', indexContent);
        });
      }
    });
  });
};

deviceListController.changeUpdate = function(req, res) {
  DeviceModel.findById(req.params.id, function(err, matchedDevice) {
    if (err || !matchedDevice) {
      let indexContent = {};
      indexContent.type = 'danger';
      indexContent.message = err.message;
      return res.status(500).json({success: false,
                                   message: 'Erro ao encontrar dispositivo'});
    }
    // Cast to boolean so that javascript works as intended
    let doUpdate = req.body.do_update;
    if (typeof req.body.do_update === 'string') {
      doUpdate = (req.body.do_update === 'true');
    }
    // Reject update command to mesh slave, use command on mesh master instead
    if (matchedDevice.mesh_master && doUpdate) {
      return res.status(500).json({
        success: false,
        message: 'Este CPE é secundário em uma rede mesh, sua atualização '+
                 'deve ser feita a partir do CPE principal dessa rede',
      });
    }
    matchedDevice.do_update = doUpdate;
    if (doUpdate) {
      matchedDevice.do_update_status = 0; // waiting
      matchedDevice.release = req.params.release.trim();
      messaging.sendUpdateMessage(matchedDevice);
      // Set mesh master's remaining updates field to keep track of network
      // update progress. This is only a helper value for the frontend.
      if (matchedDevice.mesh_slaves && matchedDevice.mesh_slaves.length > 0) {
        let slaveCount = matchedDevice.mesh_slaves.length;
        matchedDevice.do_update_mesh_remaining = slaveCount + 1;
      }
    } else {
      matchedDevice.do_update_status = 1; // success
      meshHandlers.syncUpdateCancel(matchedDevice);
    }
    matchedDevice.save(function(err) {
      if (err) {
        let indexContent = {};
        indexContent.type = 'danger';
        indexContent.message = err.message;
        return res.status(500).json({success: false,
                                     message: 'Erro ao registrar atualização'});
      }

      mqtt.anlixMessageRouterUpdate(matchedDevice._id);
      res.status(200).json({'success': true});

      // Start ack timeout
      deviceHandlers.timeoutUpdateAck(matchedDevice._id);
    });
  });
};

deviceListController.changeUpdateMesh = function(req, res) {
  DeviceModel.findById(req.params.id, function(err, matchedDevice) {
    if (err || !matchedDevice) {
      let indexContent = {};
      indexContent.type = 'danger';
      indexContent.message = err.message;
      return res.status(500).json({success: false,
                                   message: 'Erro ao encontrar dispositivo'});
    }
    // Cast to boolean so that javascript works as intended
    let doUpdate = req.body.do_update;
    if (typeof req.body.do_update === 'string') {
      doUpdate = (req.body.do_update === 'true');
    }
    // Reject update cancel command to mesh slave, use above function instead
    if (!doUpdate) {
      return res.status(500).json({
        success: false,
        message: 'Esta função só deve ser usada para marcar um slave para '+
          'atualizar, não para cancelar a atualização',
      });
    }
    matchedDevice.do_update = true;
    matchedDevice.do_update_status = 0; // waiting
    matchedDevice.release = req.params.release.trim();
    messaging.sendUpdateMessage(matchedDevice);
    matchedDevice.save(function(err) {
      if (err) {
        let indexContent = {};
        indexContent.type = 'danger';
        indexContent.message = err.message;
        return res.status(500).json({success: false,
                                     message: 'Erro ao registrar atualização'});
      }

      mqtt.anlixMessageRouterUpdate(matchedDevice._id);
      res.status(200).json({'success': true});

      // Start ack timeout
      deviceHandlers.timeoutUpdateAck(matchedDevice._id);
    });
  });
};

deviceListController.changeAllUpdates = function(req, res) {
  let form = JSON.parse(req.body.content);
  DeviceModel.find({'_id': {'$in': Object.keys(form.ids)}},
  function(err, matchedDevices) {
    if (err) {
      let indexContent = {};
      indexContent.type = 'danger';
      indexContent.message = err.message;
      return res.render('error', indexContent);
    }

    let scheduledDevices = [];
    for (let idx = 0; idx < matchedDevices.length; idx++) {
      matchedDevices[idx].do_update = form.do_update;
      if (form.do_update) {
        matchedDevices[idx].release = form.ids[matchedDevices[idx]._id].trim();
        matchedDevices[idx].do_update_status = 0; // waiting
        messaging.sendUpdateMessage(matchedDevices[idx]);
      } else {
        matchedDevices[idx].do_update_status = 1; // success
      }
      matchedDevices[idx].save();
      mqtt.anlixMessageRouterUpdate(matchedDevices[idx]._id);
      scheduledDevices.push(matchedDevices[idx]._id);
    }

    return res.status(200).json({'success': true, 'devices': scheduledDevices});
  });
};

deviceListController.simpleSearchDeviceQuery = function(queryContents) {
  let finalQuery = {};
  let queryContentNoCase = new RegExp('^' + escapeRegExp(queryContents[0]) +
                                      '$', 'i');
  if (queryContents[0].length > 0) {
    finalQuery.$or = [
      {pppoe_user: queryContentNoCase},
      {_id: queryContentNoCase},
      {'external_reference.data': queryContentNoCase},
    ];
  } else {
    finalQuery = {_id: ''};
  }
  return finalQuery;
};

deviceListController.complexSearchDeviceQuery = async function(queryContents,
 mqttClients, lastHour, tr069Times) {
  let finalQuery = {};
  let finalQueryArray = [];

  // Defaults to match all query contents
  let queryLogicalOperator = '$and';
  if (queryContents.includes('/ou')) {
    queryLogicalOperator = '$or';
    queryContents = queryContents.filter((query) => query !== '/ou');
  }
  queryContents = queryContents.filter((query) => query !== '/e');
  // setting higher level logical operator for 'finalQuery'.
  finalQuery[queryLogicalOperator] = finalQueryArray;

  // tags that are computed differently for each communication protocol.
  let statusTags = {
    'online': /^online$/, 'instavel': /^instavel$/, 'offline': /^offline$/,
    'offline >': /^offline >.*/,
  };
  // mapping to regular expression because one tag has a parameter inside and
  // won't make an exact match, but the other tags need to be exact.
  let matchedConfig = await Config.findOne({is_default: true});

  for (let idx=0; idx < queryContents.length; idx++) {
    let tag = queryContents[idx].toLowerCase(); // assigning tag to variable.
    let query = {}; // to be appended to array of queries used in pagination.

    if (Object.values(statusTags).some((r) => r.test(tag))) {
    // if we need more than one query for each controller protocol.

      /* if arguments are undefined, we define them only if we are going to use
 them. */
      if (mqttClients === undefined) {
        mqttClients = mqtt.getConnectedClients();
      }
      let currentTime = Date.now();
      if (lastHour === undefined) {
        lastHour = new Date(currentTime -3600000);
      }
      if (tr069Times === undefined) {
        let tr069 = await getOnlyTR069Configs('Error when getting tr069 '
        +'parameters in database to for \'complexSearchDeviceQuery\'.');
        tr069Times = { // thresholds for tr069 status classification.
          // time when devices are considered in recovery for tr069.
          recovery: new Date(currentTime - (tr069.inform_interval*
           tr069.recovery_threshold)),
          // time when devices are considered offline for tr069.
          offline: new Date(currentTime - (tr069.inform_interval*
           tr069.offline_threshold)),
        };
      }

      // variables that will hold one query for each controller protocol.
      let flashbox; let tr069;

      // each tag has their specific query for each controller protocol.
      if (statusTags['online'].test(tag)) {
        flashbox = {
          _id: {$in: mqttClients},
        };
        tr069 = {last_contact: {$gte: tr069Times.recovery}};
      } else if (statusTags['instavel'].test(tag)) {
        flashbox = {
          _id: {$nin: mqttClients},
          last_contact: {$gte: lastHour},
        };
        tr069 = {
          last_contact: {$lt: tr069Times.recovery, $gte: tr069Times.offline},
        };
      } else if (statusTags['offline'].test(tag)) {
        flashbox = {
          _id: {$nin: mqttClients},
          last_contact: {$lt: lastHour},
        };
        tr069 = {last_contact: {$lt: tr069Times.offline}};
      } else if (statusTags['offline >'].test(tag)) {
        const parsedHour = Math.abs(parseInt(tag.split('>')[1]));
        const hourThreshold = !isNaN(parsedHour) ? parsedHour*3600000 : 0;
        flashbox = {
          _id: {$nin: mqttClients},
          last_contact: {$lt: new Date(lastHour - hourThreshold)},
        };
        tr069 = {last_contact:
          {$lt: new Date(tr069Times.offline - hourThreshold)},
        };
      }
      flashbox.use_tr069 = {$ne: true}; // this will select only flashbox.
      tr069.use_tr069 = true; // this will select only tr069.
      query.$or = [flashbox, tr069]; // select either one.
    } else if (/^(?:update|upgrade) (?:on|off)$/.test(tag)) {
    // update|upgrade on|off.
      query.use_tr069 = {$ne: true}; // only for flashbox.
      if (tag.includes('on')) { // 'update on' or 'upgrade on'.
        query.do_update = {$eq: true};
      } else if (tag.includes('off')) { // 'update off' or 'upgrade off'.
        query.do_update = {$eq: false};
      } 
    } else if (/^(sinal) (?:erro|bom|ruim)$/.test(tag)) { 
      query.use_tr069 = true; // only for ONUs
      if (matchedConfig.pon_signal_threshold === undefined &&
          matchedConfig.pon_signal_threshold_critical === undefined &&
          matchedConfig.pon_signal_threshold_critical_high === undefined) {
        if (tag.includes('erro')) {
          query.pon_rxpower = {$gte: 3};
        } else if (tag.includes('bom')) {
          query.pon_rxpower = {$gte: -18};
        } else if (tag.includes('ruim')) {
          query.pon_rxpower = {$lte: -23};
        }
      } else { 
        if (tag.includes('ruim')) {
          query.pon_rxpower = {
            $gte: matchedConfig.pon_signal_threshold_critical_high
          };
        } else if (tag.includes('bom')) {
          query.pon_rxpower = {$lte: matchedConfig.pon_signal_threshold};
        } else if (tag.includes('ruim')) {
          query.pon_rxpower = {
            $lte: matchedConfig.pon_signal_threshold_critical
          };
        }
      }
    } else if (/^sem sinal$/.test(tag)) {
      query.use_tr069 = true; // only for ONUs
      query.pon_rxpower = {$exists: false}
    } else if (tag === 'flashbox') { // Anlix Flashbox routers.
      query.use_tr069 = {$ne: true};
    } else if (tag === 'tr069') { // ONU routers.
      query.use_tr069 = true;
    } else if (queryContents[idx] !== '') { // all other non empty filters.
      let queryArray = [];
      let contentCondition = '$or';
      // Check negation condition
      if (queryContents[idx].startsWith('/excluir')) {
        const filterContent = queryContents[idx].split('/excluir')[1].trim();
        let queryInput = new RegExp(escapeRegExp(filterContent), 'i');
        for (let property in DeviceModel.schema.paths) {
          if (DeviceModel.schema.paths.hasOwnProperty(property) &&
              DeviceModel.schema.paths[property].instance === 'String') {
            let field = {};
            field[property] = {$not: queryInput};
            queryArray.push(field);
          }
        }
        contentCondition = '$and';
      } else {
        let queryInput = new RegExp(escapeRegExp(queryContents[idx]), 'i');
        for (let property in DeviceModel.schema.paths) {
          if (DeviceModel.schema.paths.hasOwnProperty(property) &&
              DeviceModel.schema.paths[property].instance === 'String') {
            let field = {};
            field[property] = queryInput;
            queryArray.push(field);
          }
        }
      }
      query[contentCondition] = queryArray;
    }
    finalQueryArray.push(query); // appending query to array of queries.
  }

  // only return 'finalQuery' if 'finalQueryArray' isn't empty.
  if (finalQueryArray.length > 0) return finalQuery;
  else return {};
};

deviceListController.searchDeviceReg = async function(req, res) {
  let reqPage = 1;
  let elementsPerPage = 10;
  let queryContents = req.body.filter_list.split(',');
  let sortKeys = {};
  let sortTypeOrder = 1;
  // Filter sort type order before filtering query
  if (queryContents.includes('/sort-type-asc')) {
    queryContents= queryContents.filter((query) => query !== '/sort-type-asc');
    sortTypeOrder = 1;
  } else if (queryContents.includes('/sort-type-desc')) {
    queryContents= queryContents.filter((query) => query !== '/sort-type-desc');
    sortTypeOrder = -1;
  }
  // Filter sort option before filtering query
  if (queryContents.includes('/sort-pppoe-usr')) {
    queryContents= queryContents.filter((query) => query !== '/sort-pppoe-usr');
    sortKeys.pppoe_user = sortTypeOrder;
  } else if (queryContents.includes('/sort-mac-addr')) {
    queryContents= queryContents.filter((query) => query !== '/sort-mac-addr');
    sortKeys._id = sortTypeOrder;
  } else if (queryContents.includes('/sort-wan-ip')) {
    queryContents= queryContents.filter((query) => query !== '/sort-wan-ip');
    sortKeys.wan_ip = sortTypeOrder;
  } else if (queryContents.includes('/sort-public-ip')) {
    queryContents= queryContents.filter((query) => query !== '/sort-public-ip');
    sortKeys.ip = sortTypeOrder;
  } else if (queryContents.includes('/sort-release')) {
    queryContents= queryContents.filter((query) => query !== '/sort-release');
    sortKeys.installed_release = sortTypeOrder;
  } else if (queryContents.includes('/sort-ext-ref')) {
    queryContents= queryContents.filter((query) => query !== '/sort-ext-ref');
    sortKeys['external_reference.data'] = sortTypeOrder;
  } else if (queryContents.includes('/sort-sys-uptime')) {
    queryContents = queryContents.filter(
      (query) => query !== '/sort-sys-uptime');
    sortKeys.sys_up_time = sortTypeOrder;
  } else if (queryContents.includes('/sort-wan-uptime')) {
    queryContents = queryContents.filter(
      (query) => query !== '/sort-wan-uptime');
    sortKeys.wan_up_time = sortTypeOrder;
  } else {
    sortKeys._id = sortTypeOrder;
  }

  let currentTime = Date.now();
  let lastHour = new Date(currentTime -3600000);
  // getting user configurations.
  let matchedConfig = await Config.findOne({is_default: true},
    'tr069 pppoePassLength').exec().catch((err) => err);
  if (matchedConfig.constructor === Error) {
    console.log('Error when getting user config in database to build '
      +'device list.');
    return;
  }
  let tr069Times = { // thresholds for tr069 status classification.
    // time when devices are considered in recovery for tr069.
    recovery: new Date(currentTime - (matchedConfig.tr069.inform_interval*
      matchedConfig.tr069.recovery_threshold)),
    // time when devices are considered offline for tr069.
    offline: new Date(currentTime - (matchedConfig.tr069.inform_interval*
      matchedConfig.tr069.offline_threshold)),
  };


  // online devices.
  // will be passed to the functions that need an array of ids.
  let mqttClientsArray = mqtt.getConnectedClients();
  // will be used in functions that need to access devices per id.
  let mqttClientsMap = {};
  for (let i = 0; i < mqttClientsArray.length; i++) {
    mqttClientsMap[mqttClientsArray[i]] = true;
  }

  const userRole = await Role.findOne({
    name: util.returnObjOrEmptyStr(req.user.role),
  });
  let finalQuery;
  if (req.user.is_superuser || userRole.grantSearchLevel >= 2) {
    finalQuery = await deviceListController.complexSearchDeviceQuery(
     queryContents, mqttClientsArray, lastHour, tr069Times);
  } else {
    finalQuery = deviceListController.simpleSearchDeviceQuery(queryContents);
  }

  if (req.query.page) {
    reqPage = parseInt(req.query.page);
  }
  if (req.user.maxElementsPerPage) {
    elementsPerPage = req.user.maxElementsPerPage;
  }

  let paginateOpts = {
    page: reqPage,
    limit: elementsPerPage,
    lean: true,
    sort: sortKeys,
  };
  // Keys to optionally filter returned results
  if ('query_result_filter' in req.body) {
    let queryResFilter = req.body.query_result_filter.split(',');
    if (Array.isArray(queryResFilter) && queryResFilter.length) {
      paginateOpts.select = queryResFilter;
    }
  }

  DeviceModel.paginate(finalQuery, paginateOpts, function(err, matchedDevices) {
    if (err) {
      return res.json({
        success: false,
        type: 'danger',
        message: err.message,
      });
    }
    deviceListController.getReleases(userRole, req.user.is_superuser)
    .then(function(releases) {
      let enrichDevice = function(device) {
        const model = device.model.replace('N/', '');
        const devReleases = releases.filter(
          (release) => release.model === model);
        const isDevOn = mqttClientsMap[device._id.toUpperCase()];
        device.releases = devReleases;

        // Status color
        let deviceColor = 'grey-text';
        if (device.use_tr069) { // if this device uses tr069 to be controlled.
          if (device.last_contact >= tr069Times.recovery) {
          // if we are inside first threshold.
            deviceColor = 'green-text';
          } else if (device.last_contact >= tr069Times.offline) {
          // if we are inside second threshold.
            deviceColor = 'red-text';
          }
          // if we are out of these thresholds, we keep the default gray value.
        } else { // default device, flashbox controlled.
          if (isDevOn) {
            deviceColor = 'green-text';
          } else if (device.last_contact.getTime() >= lastHour.getTime()) {
            deviceColor = 'red-text';
          }
        }
        device.status_color = deviceColor;

        // Device permissions
        device.permissions = DeviceVersion.findByVersion(
          device.version,
          device.wifi_is_5ghz_capable,
          device.model,
        );

        // amount ports a device have
        device.qtdPorts = DeviceVersion.getPortsQuantity(device.model);

        // Fill default value if wi-fi state does not exist
        if (device.wifi_state === undefined) {
          device.wifi_state = 1;
          device.wifi_state_5ghz = 1;
        }
        if (device.wifi_power === undefined) {
          device.wifi_power = 100;
          device.wifi_power_5ghz = 100;
        }
        if (device.wifi_hidden === undefined) {
          device.wifi_hidden = 0;
          device.wifi_hidden_5ghz = 0;
        }
        if (device.ipv6_enabled === undefined) {
          device.ipv6_enabled = 0;
        }
        return device;
      };

      meshHandlers.enhanceSearchResult(matchedDevices.docs)
      .then(function(extra) {
        let allDevices = extra.concat(matchedDevices.docs).map(enrichDevice);
        User.findOne({name: req.user.name}, function(err, user) {
          Config.findOne({is_default: true}, function(err, matchedConfig) {
            getOnlineCount(finalQuery, mqttClientsArray, lastHour, tr069Times)
            .then((onlineStatus) => {
              // Counters
              let status = {};
              status = Object.assign(status, onlineStatus);
              // Filter data using user permissions
              deviceListController.getReleases(userRole,
                                               req.user.is_superuser, true)
              .then(function(singleReleases) {
                /* validate if is to show ssid prefix checkbox
                    for each device */
                let ssidPrefix = matchedConfig.ssidPrefix;
                let enabledForAllFlashman = (
                  !!matchedConfig.personalizationHash &&
                    matchedConfig.isSsidPrefixEnabled);
                allDevices.forEach(function(device) {
                  /*
                    Define if is to show ssid prefix
                    checkbox by checking the existence of
                    personalization hash and if ssid prefix
                    is enabled for all flashman.
                    Or else, case ssid prefix is enabled
                    for that device, is enough to be able
                    to show.
                  */
                  device.isToShowSsidPrefixCheckbox =
                    (enabledForAllFlashman == true ||
                    device.isSsidPrefixEnabled == true);
                });

                return res.json({
                success: true,
                  type: 'success',
                  limit: req.user.maxElementsPerPage,
                  page: matchedDevices.page,
                  pages: matchedDevices.pages,
                  min_length_pass_pppoe: matchedConfig.pppoePassLength,
                  status: status,
                  single_releases: singleReleases,
                  filter_list: req.body.filter_list,
                  devices: allDevices,
                  ssidPrefix: ssidPrefix,
                  isSsidPrefixEnabled: enabledForAllFlashman,
                });
              });
            }, (error) => {
              return res.json({
                success: false,
                type: 'danger',
                message: (error.message ? error.message : error),
              });
            });
          });
        });
      });
    });
  });
};

deviceListController.delDeviceReg = function(req, res) {
  DeviceModel.find({'_id': {$in: req.body.ids}}, function(err, devices) {
    if (err || !devices) {
      console.log('User delete error: ' + err);
      return res.json({
        success: false,
        type: 'danger',
        message: 'Erro interno ao remover cadastro(s)',
      });
    }
    devices.forEach((device) => {
      deviceHandlers.removeDeviceFromDatabase(device);
    });
    return res.json({
      success: true,
      type: 'success',
      message: 'Cadastro(s) removido(s) com sucesso!',
    });
  });
};

const downloadStockFirmware = async function(model) {
  return new Promise(async (resolve, reject) => {
    let remoteFileUrl = stockFirmwareLink + model + '_9999-aix.zip';
    try {
      // Download md5 hash
      let targetMd5 = await requestPromise({
        url: remoteFileUrl + '.md5',
        method: 'GET',
      });
      let currentMd5 = '';
      let localMd5Path = imageReleasesDir + '.' + model + '_9999-aix.zip.md5';
      // Check for local md5 hash
      if (fs.existsSync(localMd5Path)) {
        currentMd5 = fs.readFileSync(localMd5Path, 'utf8');
      }
      if (targetMd5 !== currentMd5) {
        // Mismatch, download new zip file
        console.log('UPDATE: Downloading factory reset fware for '+model+'...');
        fs.writeFileSync(localMd5Path, targetMd5);
        let responseStream = request({url: remoteFileUrl, method: 'GET'})
        .on('error', (err)=>{
          console.log(err);
          return resolve(false);
        })
        .on('response', (resp)=>{
          if (resp.statusCode !== 200) {
            return resolve(false);
          }
          responseStream.pipe(unzipper.Parse()).on('entry', (entry)=>{
            let fname = entry.path;
            let writeStream = fs.createWriteStream(imageReleasesDir + fname);
            writeStream.on('close', ()=>{
              let md5fname = imageReleasesDir + '.' + fname.replace('.bin', '.md5');
              let binfname = imageReleasesDir + fname;
              let md5Checksum = md5File.sync(binfname);
              fs.writeFileSync(md5fname, md5Checksum);
              return resolve(true);
            });
            entry.pipe(writeStream);
          });
        });
      } else {
        // Hashes match, local file is ok
        return resolve(true);
      }
    } catch (err) {
      if (err.statusCode !== 404) {
        console.log(err.statusCode);
      }
      return resolve(false);
    }
  });
};

deviceListController.factoryResetDevice = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(), async (err, device) => {
    if (err || !device) {
      return res.status(500).json({
        success: false,
        message: 'CPE não encontrado na base de dados',
      });
    }
    const model = device.model.replace('N/', '');
    if (!(await downloadStockFirmware(model))) {
      return res.status(500).json({
        success: false,
        msg: 'Erro baixando a firmware de fábrica',
      });
    }
    device.do_update = true;
    device.do_update_status = 0; // waiting
    device.release = '9999-aix';
    await device.save();
    console.log('UPDATE: Factory resetting router ' + device._id + '...');
    mqtt.anlixMessageRouterUpdate(device._id);
    res.status(200).json({success: true});
    // Start ack timeout
    deviceHandlers.timeoutUpdateAck(device._id);
  });
};

//
// REST API only functions
//

deviceListController.sendMqttMsg = function(req, res) {
  let msgtype = req.params.msg.toLowerCase();

  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, device) {
    if (err) {
      return res.status(200).json({success: false,
                                   message: 'Erro interno do servidor'});
    }
    if (device == null) {
      return res.status(200).json({success: false,
                                   message: 'CPE não encontrado'});
    }
    let permissions = DeviceVersion.findByVersion(device.version,
                                                  device.wifi_is_5ghz_capable,
                                                  device.model);

    switch (msgtype) {
      case 'rstapp':
        if (device) {
          device.app_password = undefined;
          device.save();
        }
        mqtt.anlixMessageRouterResetApp(req.params.id.toUpperCase());
        break;
      case 'rstdevices':
        if (!permissions.grantResetDevices) {
          return res.status(200).json({
            success: false,
            message: 'CPE não possui essa função!',
          });
        } else if (device) {
          device.lan_devices = device.lan_devices.map((lanDevice) => {
            lanDevice.is_blocked = false;
            return lanDevice;
          });
          device.blocked_devices_index = Date.now();
          device.save();
        }
        mqtt.anlixMessageRouterUpdate(req.params.id.toUpperCase());
        break;
      case 'rstmqtt':
        if (device) {
          device.mqtt_secret = undefined;
          device.mqtt_secret_bypass = true;
          device.save();
        }
        mqtt.anlixMessageRouterResetMqtt(req.params.id.toUpperCase());
        break;
      case 'updateupnp':
        if (device) {
          let lanDeviceId = req.body.lanid;
          let lanDevicePerm = (req.body.permission === 'accept' ?
                               'accept' : 'reject');
          device.lan_devices.filter(function(lanDevice) {
            if (lanDevice.mac.toUpperCase() === lanDeviceId.toUpperCase()) {
              lanDevice.upnp_permission = lanDevicePerm;
              device.upnp_devices_index = Date.now();
              return true;
            } else {
              return false;
            }
          });
          device.save(function(err) {
            mqtt.anlixMessageRouterUpdate(req.params.id.toUpperCase());
          });
        }
        break;
      case 'log':
      case 'boot':
      case 'onlinedevs':
      case 'ping':
      case 'upstatus':
      case 'upstatustr069':
      case 'speedtest':
      case 'wps':
      case 'sitesurvey': {
        const isDevOn = Object.values(mqtt.unifiedClientsMap).some((map)=>{
          return map[req.params.id.toUpperCase()];
        });
        if (device && !device.use_tr069 && !isDevOn) {
          return res.status(200).json({success: false,
                                     message: 'CPE não esta online!'});
        }
        if (msgtype === 'speedtest') {
          return deviceListController.doSpeedTest(req, res);
        } else if (msgtype === 'boot') {
          if (device && device.use_tr069) {
            // acs integration will respond to request
            return acsDeviceInfo.rebootDevice(device, res);
          } else {
            mqtt.anlixMessageRouterReboot(req.params.id.toUpperCase());
          }
        } else if (msgtype === 'onlinedevs') {
          let slaves = (device.mesh_slaves) ? device.mesh_slaves : [];
          if (req.sessionID && sio.anlixConnections[req.sessionID]) {
            sio.anlixWaitForOnlineDevNotification(
              req.sessionID,
              req.params.id.toUpperCase(),
            );
            slaves.forEach((slave)=>{
              sio.anlixWaitForOnlineDevNotification(
                req.sessionID,
                slave.toUpperCase(),
              );
            });
          }
          if (device && device.use_tr069) {
            acsDeviceInfo.requestConnectedDevices(device);
          } else {
            mqtt.anlixMessageRouterOnlineLanDevs(req.params.id.toUpperCase());
            slaves.forEach((slave)=>{
              mqtt.anlixMessageRouterOnlineLanDevs(slave.toUpperCase());
            });
          }
        } else if (msgtype === 'sitesurvey') {
          if (req.sessionID && sio.anlixConnections[req.sessionID]) {
            sio.anlixWaitForSiteSurveyNotification(
              req.sessionID, req.params.id.toUpperCase());
          }
          mqtt.anlixMessageRouterSiteSurvey(req.params.id.toUpperCase());
        } else if (msgtype === 'ping') {
          if (req.sessionID && sio.anlixConnections[req.sessionID]) {
            sio.anlixWaitForPingTestNotification(
              req.sessionID, req.params.id.toUpperCase());
          }
          mqtt.anlixMessageRouterPingTest(req.params.id.toUpperCase());
        } else if (msgtype === 'upstatus') {
          let slaves = (device.mesh_slaves) ? device.mesh_slaves : [];
          if (req.sessionID && sio.anlixConnections[req.sessionID]) {
            sio.anlixWaitForUpStatusNotification(
              req.sessionID,
              req.params.id.toUpperCase(),
            );
            slaves.forEach((slave)=>{
              sio.anlixWaitForUpStatusNotification(
                req.sessionID,
                slave.toUpperCase(),
              );
            });
          }
          if (device && device.use_tr069) {
            acsDeviceInfo.requestWanBytes(device);
          } else {
            mqtt.anlixMessageRouterUpStatus(req.params.id.toUpperCase());
            slaves.forEach((slave)=>{
              mqtt.anlixMessageRouterUpStatus(slave.toUpperCase());
            });
          }
        } else if (msgtype === 'upstatustr069') {
          let slaves = (device.mesh_slaves) ? device.mesh_slaves : [];
          if (req.sessionID && sio.anlixConnections[req.sessionID]) {
            sio.anlixWaitForUpStatusTr069Notification(
              req.sessionID,
              req.params.id.toUpperCase(),
            );
            slaves.forEach((slave)=>{
              sio.anlixWaitForUpStatusTr069Notification(
                req.sessionID,
                slave.toUpperCase(),
              );
            });
          }
          if (device && device.use_tr069) {
            acsDeviceInfo.requestUpStatus(device);
          }
        } else if (msgtype === 'log') {
          // This message is only valid if we have a socket to send response to
          if (sio.anlixConnections[req.sessionID]) {
            sio.anlixWaitForLiveLogNotification(
              req.sessionID, req.params.id.toUpperCase());
            if (device && device.use_tr069) {
              acsDeviceInfo.requestLogs(device);
            } else {
              mqtt.anlixMessageRouterLog(req.params.id.toUpperCase());
            }
          } else {
            return res.status(200).json({
              success: false,
              message: 'Esse comando somente funciona em uma sessão!',
            });
          }
        } else if (msgtype === 'wps') {
          if (!('activate' in req.params) ||
              !(typeof req.params.activate === 'boolean')
          ) {
            return res.status(200).json({
              success: false,
              message: 'Erro na requisição'});
          }
          mqtt.anlixMessageRouterWpsButton(req.params.id.toUpperCase(),
                                           req.params.activate);
        } else {
          return res.status(200).json({
            success: false,
            message: 'Esse comando não existe',
          });
        }
        break;
      }
      default:
        // Message not implemented
        console.log('REST API MQTT Message not recognized (' + msgtype + ')');
        return res.status(200).json({success: false,
                                     message: 'Esse comando não existe'});
    }

    return res.status(200).json({success: true});
  });
};

deviceListController.getFirstBootLog = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({success: false,
                                   message: 'Erro interno do servidor'});
    }
    if (matchedDevice == null) {
      return res.status(200).json({success: false,
                                   message: 'CPE não encontrado'});
    }

    if (matchedDevice.firstboot_log) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'text/plain');
      res.end(matchedDevice.firstboot_log, 'binary');
      return res.status(200);
    } else {
      return res.status(200).json({success: false,
                                   message: 'Não existe log deste CPE'});
    }
  });
};

deviceListController.getLastBootLog = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({success: false,
                                   message: 'Erro interno do servidor'});
    }
    if (matchedDevice == null) {
      return res.status(200).json({success: false,
                                   message: 'CPE não encontrado'});
    }

    if (matchedDevice.lastboot_log) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'text/plain');
      res.end(matchedDevice.lastboot_log, 'binary');
      return res.status(200);
    } else {
      return res.status(200).json({success: false,
                                   message: 'Não existe log deste CPE'});
    }
  });
};

deviceListController.getDeviceReg = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase()).lean().exec(
  async function(err, matchedDevice) {
    if (err) {
      return res.status(500).json({success: false,
                                   message: 'Erro interno do servidor'});
    }
    if (matchedDevice == null) {
      return res.status(404).json({success: false,
                                   message: 'CPE não encontrado'});
    }

    // hide secret from api
    if (matchedDevice.mqtt_secret) {
      matchedDevice.mqtt_secret = null;
    }

    // hide logs - too large for json
    if (matchedDevice.firstboot_log) {
      matchedDevice.firstboot_log = null;
    }
    if (matchedDevice.lastboot_log) {
      matchedDevice.lastboot_log = null;
    }

    let deviceColor = 'grey';
    matchedDevice.online_status = false;
    if (matchedDevice.use_tr069) { // if this matchedDevice uses tr069.
      // getting tr069 inform parameters.
      let tr069Configs = await getOnlyTR069Configs('Error when getting tr069 '
        +'parameters in database to set tr069 status color in device list '
        +'line item.');
      let currentTime = Date.now();
      // // thresholds for tr069 status classification.
      // time when devices are considered in recovery for tr069.
      let recoveryTime = new Date(currentTime - (tr069Configs.inform_interval*
        tr069Configs.recovery_threshold));
      // time when devices are considered offline for tr069.
      let offlineTime = new Date(currentTime - (tr069Configs.inform_interval*
        tr069Configs.offline_threshold));
      // // classifying device status.
      if (matchedDevice.last_contact >= recoveryTime) {
      // if we are inside first threshold.
        deviceColor = 'green';
        matchedDevice.online_status = true;
      } else if (matchedDevice.last_contact >= offlineTime) {
      // if we are inside second threshold.
        deviceColor = 'red';
      }
      // if we are out of these thresholds, we keep the default gray value.
    } else { // default matchedDevice, flashbox controlled.
      const isDevOn = Object.values(mqtt.unifiedClientsMap).some((map)=>{
        return map[req.params.id.toUpperCase()];
      });
      matchedDevice.online_status = (isDevOn);
      // Status color
      let lastHour = new Date();
      lastHour.setHours(lastHour.getHours() - 1);
      if (matchedDevice.online_status) {
        deviceColor = 'green';
      } else if (matchedDevice.last_contact.getTime() >= lastHour.getTime()) {
        deviceColor = 'red';
      }
    }
    matchedDevice.status_color = deviceColor;

    return res.status(200).json(matchedDevice);
  });
};

deviceListController.setDeviceReg = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        errors: [],
      });
    }
    if (matchedDevice == null) {
      return res.status(404).json({
        success: false,
        message: 'CPE não encontrado',
        errors: [],
      });
    }

    if (util.isJSONObject(req.body.content)) {
      let content = req.body.content;
      let updateParameters = false;
      let validator = new Validator();

      let errors = [];
      let connectionType = util.returnObjOrEmptyStr(content.connection_type).toString().trim();
      let pppoeUser = util.returnObjOrEmptyStr(content.pppoe_user).toString().trim();
      let pppoePassword = util.returnObjOrEmptyStr(content.pppoe_password).toString().trim();
      let ipv6Enabled = parseInt(util.returnObjOrNum(content.ipv6_enabled, 2));
      let lanSubnet = util.returnObjOrEmptyStr(content.lan_subnet).toString().trim();
      let lanNetmask = parseInt(util.returnObjOrNum(content.lan_netmask, 24));
      let ssid = util.returnObjOrEmptyStr(content.wifi_ssid).toString().trim();
      let password = util.returnObjOrEmptyStr(content.wifi_password).toString().trim();
      let channel = util.returnObjOrEmptyStr(content.wifi_channel).toString().trim();
      let band = util.returnObjOrEmptyStr(content.wifi_band).toString().trim();
      let mode = util.returnObjOrEmptyStr(content.wifi_mode).toString().trim();
      let power = parseInt(util.returnObjOrNum(content.wifi_power, 100));
      let wifiState = parseInt(util.returnObjOrNum(content.wifi_state, 1));
      let wifiHidden = parseInt(util.returnObjOrNum(content.wifi_hidden, 0));
      let ssid5ghz = util.returnObjOrEmptyStr(content.wifi_ssid_5ghz).toString().trim();
      let password5ghz = util.returnObjOrEmptyStr(content.wifi_password_5ghz).toString().trim();
      let channel5ghz = util.returnObjOrEmptyStr(content.wifi_channel_5ghz).toString().trim();
      let band5ghz = util.returnObjOrEmptyStr(content.wifi_band_5ghz).toString().trim();
      let mode5ghz = util.returnObjOrEmptyStr(content.wifi_mode_5ghz).toString().trim();
      let power5ghz = parseInt(util.returnObjOrNum(content.wifi_power_5ghz, 100));
      let wifiState5ghz = parseInt(util.returnObjOrNum(content.wifi_state_5ghz, 1));
      let wifiHidden5ghz = parseInt(util.returnObjOrNum(content.wifi_hidden_5ghz, 0));
      let isSsidPrefixEnabled = parseInt(util.
        returnObjOrNum(content.isSsidPrefixEnabled, 0)) == 0 ? false : true;
      let bridgeEnabled = parseInt(util.returnObjOrNum(content.bridgeEnabled, 1)) === 1;
      let bridgeDisableSwitch = parseInt(util.returnObjOrNum(content.bridgeDisableSwitch, 1)) === 1;
      let bridgeFixIP = util.returnObjOrEmptyStr(content.bridgeFixIP).toString().trim();
      let bridgeFixGateway = util.returnObjOrEmptyStr(content.bridgeFixGateway).toString().trim();
      let bridgeFixDNS = util.returnObjOrEmptyStr(content.bridgeFixDNS).toString().trim();
      let meshMode = parseInt(util.returnObjOrNum(content.mesh_mode, 0));
      let slaveCustomConfigs = [];
      try {
        slaveCustomConfigs = JSON.parse(content.slave_custom_configs);
        if (slaveCustomConfigs.length !== matchedDevice.mesh_slaves.length) {
          slaveCustomConfigs = [];
        }
      } catch (err) {
        slaveCustomConfigs = [];
      }

      let genericValidate = function(field, func, key, minlength) {
        let validField = func(field, minlength);
        if (!validField.valid) {
          validField.err.forEach(function(error) {
            let obj = {};
            obj[key] = error;
            errors.push(obj);
          });
        }
      };

      Config.findOne({is_default: true}, async function(err, matchedConfig) {
        if (err || !matchedConfig) {
          console.log('Error returning default config');
          return res.status(500).json({
            success: false,
            message: 'Erro ao encontrar configuração',
            errors: [],
          });
        }

        // Validate fields
        if (connectionType != 'pppoe' && connectionType != 'dhcp' &&
            connectionType != '') {
          return res.status(500).json({
            success: false,
            message: 'Tipo de conexão deve ser "pppoe" ou "dhcp"',
          });
        }
        if (pppoeUser !== '' && pppoePassword !== '') {
          connectionType = 'pppoe';
          genericValidate(pppoeUser, validator.validateUser, 'pppoe_user');
          if (!matchedDevice.use_tr069 || pppoePassword) {
            // Do not validate this field if a TR069 device left it blank
            genericValidate(pppoePassword, validator.validatePassword,
                            'pppoe_password', matchedConfig.pppoePassLength);
          }
        }
        let ssidPrefix = await updateController.
          getSsidPrefix(isSsidPrefixEnabled);
        if (content.hasOwnProperty('wifi_ssid')) {
          genericValidate(ssidPrefix+ssid,
            validator.validateSSID, 'ssid');
        }
        if (content.hasOwnProperty('wifi_password')) {
          genericValidate(password, validator.validateWifiPassword, 'password');
        }
        if (content.hasOwnProperty('wifi_channel')) {
          genericValidate(channel, validator.validateChannel, 'channel');
        }
        if (content.hasOwnProperty('wifi_band')) {
          genericValidate(band, validator.validateBand, 'band');
        }
        if (content.hasOwnProperty('wifi_mode')) {
          genericValidate(mode, validator.validateMode, 'mode');
        }
        if (content.hasOwnProperty('wifi_power')) {
          genericValidate(power, validator.validatePower, 'power');
        }
        if (content.hasOwnProperty('wifi_ssid_5ghz')) {
          genericValidate(ssidPrefix+ssid5ghz,
            validator.validateSSID, 'ssid5ghz');
        }
        if (content.hasOwnProperty('wifi_password_5ghz')) {
          genericValidate(password5ghz,
                          validator.validateWifiPassword, 'password5ghz');
        }
        if (content.hasOwnProperty('wifi_channel_5ghz')) {
          genericValidate(channel5ghz,
                          validator.validateChannel, 'channel5ghz');
        }
        if (content.hasOwnProperty('wifi_band_5ghz')) {
          genericValidate(band5ghz, validator.validateBand, 'band5ghz');
        }
        if (content.hasOwnProperty('wifi_mode_5ghz')) {
          genericValidate(mode5ghz, validator.validateMode, 'mode5ghz');
        }
        if (content.hasOwnProperty('wifi_power_5ghz')) {
          genericValidate(power5ghz, validator.validatePower, 'power5ghz');
        }
        if (content.hasOwnProperty('lan_subnet')) {
          genericValidate(lanSubnet, validator.validateIP, 'lan_subnet');
          genericValidate(lanSubnet, validator.validateIPAgainst,
                          'lan_subnet', '192.168.43');
        }
        if (content.hasOwnProperty('lan_netmask')) {
          genericValidate(lanNetmask, validator.validateNetmask, 'lan_netmask');
        }
        if (bridgeEnabled && bridgeFixIP) {
          genericValidate(bridgeFixIP, validator.validateIP,
                          'bridge_fixed_ip');
          genericValidate(bridgeFixGateway, validator.validateIP,
                          'bridge_fixed_gateway');
          genericValidate(bridgeFixDNS, validator.validateIP,
                          'bridge_fixed_dns');
        }

        if (errors.length < 1) {
          Role.findOne({name: util.returnObjOrEmptyStr(req.user.role)},
          async function(err, role) {
            if (err) {
              console.log(err);
            }
            let superuserGrant = false;
            let hasPermissionError = false;

            if (!role && req.user.is_superuser) {
              superuserGrant = true;
            }
            let changes = {wan: {}, lan: {}, wifi2: {}, wifi5: {}};

            if (connectionType !== '' && !matchedDevice.bridge_mode_enabled &&
                connectionType !== matchedDevice.connection_type &&
                !matchedDevice.use_tr069) {
              if (superuserGrant || role.grantWanType) {
                if (connectionType === 'pppoe') {
                  if (pppoeUser !== '' && pppoePassword !== '') {
                    matchedDevice.connection_type = connectionType;
                    updateParameters = true;
                  }
                } else {
                  matchedDevice.connection_type = connectionType;
                  matchedDevice.pppoe_user = '';
                  matchedDevice.pppoe_password = '';
                  updateParameters = true;
                }
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('pppoe_user') &&
                pppoeUser !== '' && !matchedDevice.bridge_mode_enabled &&
                pppoeUser !== matchedDevice.pppoe_user) {
              if (superuserGrant || role.grantPPPoEInfo > 1) {
                changes.wan.pppoe_user = pppoeUser;
                matchedDevice.pppoe_user = pppoeUser;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('pppoe_password') &&
                pppoePassword !== '' && !matchedDevice.bridge_mode_enabled &&
                pppoePassword !== matchedDevice.pppoe_password) {
              if (superuserGrant || role.grantPPPoEInfo > 1) {
                changes.wan.pppoe_pass = pppoePassword;
                matchedDevice.pppoe_password = pppoePassword;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('ipv6_enabled')) {
              matchedDevice.ipv6_enabled = ipv6Enabled;
              updateParameters = true;
            }
            if (content.hasOwnProperty('wifi_ssid') &&
                ssid !== '' &&
                ssid !== matchedDevice.wifi_ssid) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi2.ssid = ssid;
                matchedDevice.wifi_ssid = ssid;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_password') &&
                password !== '' && password !== matchedDevice.wifi_password) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi2.password = password;
                matchedDevice.wifi_password = password;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_channel') &&
                channel !== '' && channel !== matchedDevice.wifi_channel) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi2.channel = channel;
                matchedDevice.wifi_channel = channel;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_band') &&
                band !== '' && band !== matchedDevice.wifi_band) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi2.band = band;
                matchedDevice.wifi_band = band;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_mode') &&
                mode !== '' && mode !== matchedDevice.wifi_mode) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi2.mode = mode;
                matchedDevice.wifi_mode = mode;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_state') &&
                wifiState !== matchedDevice.wifi_state) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi2.enable = wifiState;
                matchedDevice.wifi_state = wifiState;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_hidden') &&
                wifiHidden !== matchedDevice.wifi_hidden) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                matchedDevice.wifi_hidden = wifiHidden;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_power') &&
                power !== '' && power !== matchedDevice.wifi_power) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                matchedDevice.wifi_power = power;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_ssid_5ghz') &&
                ssid5ghz !== '' &&
                ssid5ghz !== matchedDevice.wifi_ssid_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi5.ssid = ssid5ghz;
                matchedDevice.wifi_ssid_5ghz = ssid5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_password_5ghz') &&
                password5ghz !== '' &&
                password5ghz !== matchedDevice.wifi_password_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi5.password = password5ghz;
                matchedDevice.wifi_password_5ghz = password5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_channel_5ghz') &&
                channel5ghz !== '' &&
                channel5ghz !== matchedDevice.wifi_channel_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi5.channel = channel5ghz;
                matchedDevice.wifi_channel_5ghz = channel5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_band_5ghz') &&
                band5ghz !== '' && band5ghz !== matchedDevice.wifi_band_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi5.band = band5ghz;
                matchedDevice.wifi_band_5ghz = band5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_mode_5ghz') &&
                mode5ghz !== '' && mode5ghz !== matchedDevice.wifi_mode_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi5.mode = mode5ghz;
                matchedDevice.wifi_mode_5ghz = mode5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_state_5ghz') &&
                wifiState5ghz !== matchedDevice.wifi_state_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                changes.wifi5.enable = wifiState5ghz;
                matchedDevice.wifi_state_5ghz = wifiState5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_hidden_5ghz') &&
                wifiHidden5ghz !== matchedDevice.wifi_hidden_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                matchedDevice.wifi_hidden_5ghz = wifiHidden5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('isSsidPrefixEnabled') &&
                isSsidPrefixEnabled !== matchedDevice.isSsidPrefixEnabled) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                matchedDevice.isSsidPrefixEnabled = isSsidPrefixEnabled;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('wifi_power_5ghz') &&
                power5ghz !== '' &&
                power5ghz !== matchedDevice.wifi_power_5ghz) {
              if (superuserGrant || role.grantWifiInfo > 1) {
                matchedDevice.wifi_power_5ghz = power5ghz;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('lan_subnet') &&
                lanSubnet !== '' && !matchedDevice.bridge_mode_enabled &&
                lanSubnet !== matchedDevice.lan_subnet) {
              if (superuserGrant || role.grantLanEdit) {
                changes.lan.router_ip = lanSubnet;
                matchedDevice.lan_subnet = lanSubnet;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('lan_netmask') &&
                lanNetmask !== '' && !matchedDevice.bridge_mode_enabled &&
                parseInt(lanNetmask) !== matchedDevice.lan_netmask) {
              if (superuserGrant || role.grantLanEdit) {
                changes.lan.subnet_mask = parseInt(lanNetmask);
                matchedDevice.lan_netmask = lanNetmask;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('external_reference') &&
                (content.external_reference.kind !== matchedDevice.external_reference.kind ||
                 content.external_reference.data !== matchedDevice.external_reference.data)
            ) {
              if (superuserGrant || role.grantDeviceId) {
                matchedDevice.external_reference.kind =
                  content.external_reference.kind;
                matchedDevice.external_reference.data =
                  content.external_reference.data;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('bridgeEnabled') &&
                bridgeEnabled !== matchedDevice.bridge_mode_enabled &&
                !matchedDevice.use_tr069) {
              if (superuserGrant || role.grantOpmodeEdit) {
                // in the case of changing from bridge to router : clear vlan configuration
                if(matchedDevice.bridge_mode_enabled == true && bridgeEnabled == false) {
                  matchedDevice.vlan = [];
                }

                matchedDevice.bridge_mode_enabled = bridgeEnabled;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('bridgeDisableSwitch') &&
                bridgeDisableSwitch !== matchedDevice.bridge_mode_switch_disable) {
              if (superuserGrant || role.grantOpmodeEdit) {
                matchedDevice.bridge_mode_switch_disable = bridgeDisableSwitch;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('bridgeFixIP') &&
                bridgeFixIP !== matchedDevice.bridge_mode_ip) {
              if (superuserGrant || role.grantOpmodeEdit) {
                matchedDevice.bridge_mode_ip = bridgeFixIP;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('bridgeFixIP') &&
                bridgeFixGateway !== matchedDevice.bridge_mode_gateway) {
              if (superuserGrant || role.grantOpmodeEdit) {
                matchedDevice.bridge_mode_gateway = bridgeFixGateway;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('bridgeFixIP') &&
                bridgeFixDNS !== matchedDevice.bridge_mode_dns) {
              if (superuserGrant || role.grantOpmodeEdit) {
                matchedDevice.bridge_mode_dns = bridgeFixDNS;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (content.hasOwnProperty('mesh_mode') &&
                meshMode !== matchedDevice.mesh_mode &&
                !matchedDevice.use_tr069) {
              if (superuserGrant || role.grantOpmodeEdit) {
                matchedDevice.mesh_mode = meshMode;
                updateParameters = true;
              } else {
                hasPermissionError = true;
              }
            }
            if (hasPermissionError) {
              return res.status(403).json({
                success: false,
                type: 'danger',
                message: 'Permissão insuficiente para alterar ' +
                         'campos requisitados',
              });
            }
            if (updateParameters) {
              matchedDevice.do_update_parameters = true;
            }
            matchedDevice.save(async function(err) {
              if (err) {
                console.log(err);
                return res.status(500).json({
                  success: false,
                  message: 'Erro ao salvar dados na base',
                });
              }
              if (!matchedDevice.use_tr069) {
                // flashbox device, call mqtt
                mqtt.anlixMessageRouterUpdate(matchedDevice._id);
                meshHandlers.syncSlaves(matchedDevice, slaveCustomConfigs);
              } else {
                // tr-069 device, call acs
                acsDeviceInfo.updateInfo(matchedDevice, changes);
              }

                matchedDevice.success = true;
                return res.status(200).json(matchedDevice);
            });
          });
        } else {
          return res.status(500).json({
            success: false,
            message: 'Erro validando os campos, ver campo "errors"',
            errors: errors,
          });
        }
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Erro ao tratar JSON',
        errors: [],
      });
    }
  });
};

deviceListController.createDeviceReg = function(req, res) {
  if (util.isJSONObject(req.body.content)) {
    const content = req.body.content;
    const macAddr = content.mac_address.trim().toUpperCase();
    const extReference = content.external_reference;
    const validator = new Validator();

    let errors = [];
    let release = util.returnObjOrEmptyStr(content.release).trim();
    let connectionType = util.returnObjOrEmptyStr(content.connection_type).trim();
    let pppoeUser = util.returnObjOrEmptyStr(content.pppoe_user).trim();
    let pppoePassword = util.returnObjOrEmptyStr(content.pppoe_password).trim();
    let ssid = util.returnObjOrEmptyStr(content.wifi_ssid).trim();
    let password = util.returnObjOrEmptyStr(content.wifi_password).trim();
    let channel = util.returnObjOrEmptyStr(content.wifi_channel).trim();
    let band = util.returnObjOrEmptyStr(content.wifi_band).trim();
    let mode = util.returnObjOrEmptyStr(content.wifi_mode).trim();
    let pppoe = (pppoeUser !== '' && pppoePassword !== '');

    let genericValidate = function(field, func, key, minlength) {
      let validField = func(field, minlength);
      if (!validField.valid) {
        validField.err.forEach(function(error) {
          let obj = {};
          obj[key] = error;
          errors.push(obj);
        });
      }
    };

    Config.findOne({is_default: true}, async function(err, matchedConfig) {
      if (err || !matchedConfig) {
        console.log('Error searching default config');
        return res.status(500).json({
          success: false,
          message: 'Erro ao encontrar configuração',
        });
      }

      // Validate fields
      genericValidate(macAddr, validator.validateMac, 'mac');
      if (connectionType != 'pppoe' && connectionType != 'dhcp' &&
          connectionType != '') {
        return res.status(500).json({
          success: false,
          message: 'Tipo de conexão deve ser "pppoe" ou "dhcp"',
        });
      }
      if (pppoe) {
        connectionType = 'pppoe';
        genericValidate(pppoeUser, validator.validateUser, 'pppoe_user');
        genericValidate(pppoePassword, validator.validatePassword,
                        'pppoe_password', matchedConfig.pppoePassLength);
      } else {
        connectionType = 'dhcp';
      }
      let enabledForAllFlashman = (
        !!matchedConfig.personalizationHash &&
          matchedConfig.isSsidPrefixEnabled);
      let ssidPrefix = await updateController.
        getSsidPrefix(enabledForAllFlashman);
      genericValidate(ssidPrefix+ssid,
        validator.validateSSID, 'ssid');
      genericValidate(password, validator.validateWifiPassword, 'password');
      genericValidate(channel, validator.validateChannel, 'channel');
      genericValidate(band, validator.validateBand, 'band');
      genericValidate(mode, validator.validateMode, 'mode');

      DeviceModel.findById(macAddr, function(err, matchedDevice) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Erro interno do servidor',
            errors: errors,
          });
        } else {
          if (matchedDevice) {
            errors.push({mac: 'Endereço MAC já cadastrado'});
          }
          if (errors.length < 1) {
            let newDeviceModel = new DeviceModel({
              '_id': macAddr,
              'created_at': new Date(),
              'external_reference': extReference,
              'model': '',
              'release': release,
              'pppoe_user': pppoeUser,
              'pppoe_password': pppoePassword,
              'wifi_ssid': ssid,
              'wifi_password': password,
              'wifi_channel': channel,
              'wifi_band': band,
              'wifi_mode': mode,
              'last_contact': new Date('January 1, 1970 01:00:00'),
              'do_update': false,
              'do_update_parameters': false,
              'isSsidPrefixEnabled': enabledForAllFlashman,
            });
            if (connectionType != '') {
              newDeviceModel.connection_type = connectionType;
            }
            newDeviceModel.save(function(err) {
              if (err) {
                return res.status(500).json({
                  success: false,
                  message: 'Erro ao salvar registro',
                  errors: errors,
                });
              } else {
                return res.status(200).json({'success': true});
              }
            });
          } else {
            return res.status(500).json({
              success: false,
              message: 'Erro validando os campos, ver campo \"errors\"',
              errors: errors,
            });
          }
        }
      });
    });
  } else {
    return res.status(500).json({
      success: false,
      message: 'Erro ao tratar JSON',
      errors: [],
    });
  }
};

deviceListController.checkOverlappingPorts = function(rules) {
  let i;
  let j;
  let ipI;
  let ipJ;
  let exStart;
  let exEnd;
  let inStart;
  let inEnd;
  if (rules.length > 1) {
    for (i = 0; i < rules.length; i++) {
      ipI = rules[i].ip;
      exStart = rules[i].external_port_start;
      exEnd = rules[i].external_port_end;
      inStart = rules[i].internal_port_start;
      inEnd = rules[i].internal_port_end;
      for (j = i+1; j < rules.length; j++) {
        ipJ = rules[j].ip;
        let port = rules[j].external_port_start;
        if (port >= exStart && port <= exEnd) {
          return true;
        }
        port = rules[j].external_port_end;
        if (port >= exStart && port <= exEnd) {
          return true;
        }
        port = rules[j].internal_port_start;
        if (ipI == ipJ && port >= inStart && port <= inEnd) {
          return true;
        }
        port = rules[j].internal_port_end;
        if (ipI == ipJ && port >= inStart && port <= inEnd) {
          return true;
        }
      }
    }
  }
  return false;
};

/*
Function to check if exists rules that are not compatible to the device:
  Returns true case exist a rule that is not possible to do in the device;
  False if is all clean;
*/
deviceListController.checkIncompatibility = function(rules, compatibility) {
  let ret = false;
  let i;
  let exStart;
  let exEnd;
  let inStart;
  let inEnd;
  for (i = 0; i < rules.length; i++) {
    exStart = rules[i].external_port_start;
    exEnd = rules[i].external_port_end;
    inStart = rules[i].internal_port_start;
    inEnd = rules[i].internal_port_end;
    if (!compatibility.simpleSymmetric) {
      if (exStart == exEnd && inStart == inEnd) {
        ret = true;
      }
    }
    if (!compatibility.simpleAsymmetric) {
      if (exStart != inStart && exEnd != inEnd) {
        ret = true;
      }
    }
    if (!compatibility.rangeSymmetric) {
      if (exStart != exEnd && inStart != inEnd) {
        ret = true;
      }
    }
    if (!compatibility.rangeAsymmetric) {
      if (exStart != inStart && exEnd != inEnd &&
         exStart != exEnd && inStart != inEnd) {
        ret = true;
      }
    }
  }
  return ret;
};

deviceListController.setPortForwardTr069 = async function(device, content) {
  let i;
  let j;
  let rules;
  let isOnSubnetRange;
  let isPortsNumber;
  let isPortsOnRange;
  let isPortsNotEmpty;
  let isRangeOfSameSize;
  let isRangeNegative;
  let isJsonInFormat;
  let portToCheck;
  let portsValues;
  let firstSlice;
  let secondSlice;
  let diffPortForwardLength;
  let ret = {};
  try {
    rules = JSON.parse(content);
  } catch (e) {
    console.log(e.message);
    ret.success = false;
    ret.message = 'Não é um JSON';
    return ret;
  }

  // verify well formation of rules object
  if (Array.isArray(rules)) {
    isJsonInFormat = rules.every((r) => {
      return !!r.ip &&
       !!r.external_port_start &&
       !!r.external_port_end &&
       !!r.internal_port_start &&
       !!r.internal_port_end;
    });
  } else {
    isJsonInFormat = false;
  }
  if (!isJsonInFormat) {
    ret.success = false;
    ret.message = 'JSON fora do formato';
    return ret;
  }
  for (i = 0; i < rules.length; i++) {
    isPortsNumber = true;
    isPortsOnRange = true;
    isPortsNotEmpty = true;
    isRangeOfSameSize = true;
    isRangeNegative = true;
    portsValues = [];
    portsValues[0] = rules[i].external_port_start;
    portsValues[1] = rules[i].external_port_end;
    portsValues[2] = rules[i].internal_port_start;
    portsValues[3] = rules[i].internal_port_end;
    // verify if the given ip is on subnet range
    let validator = new Validator();
    isOnSubnetRange = validator.checkAddressSubnetRange(
      device.lan_subnet,
      rules[i].ip,
      device.lan_netmask,
    );
    // verify if is number, empty, on 2^16 range,
    for (j = 0; j < 4; j++) {
      portToCheck = portsValues[j];
      if (portToCheck == '') {
        isPortsNotEmpty = false;
      } else if (isNaN(parseInt(portToCheck))) {
        isPortsNumber = false;
      } else if (!(parseInt(portToCheck) >= 1 &&
                   parseInt(portToCheck) <= 65535 &&
                   parseInt(portToCheck) != 22 &&
                   parseInt(portToCheck) != 23 &&
                   parseInt(portToCheck) != 80 &&
                   parseInt(portToCheck) != 443 &&
                   parseInt(portToCheck) != 7547 &&
                   parseInt(portToCheck) != 58000)) {
        isPortsOnRange = false;
      }
    }
    if (!isPortsNumber) {
      ret.success = false;
      ret.message = ''+rules[i].ip+': As portas devem ser números';
      return ret;
    }
    // verify if range is on same size and start/end order
    firstSlice = parseInt(portsValues[1]) - parseInt(portsValues[0]);
    secondSlice = parseInt(portsValues[3]) - parseInt(portsValues[2]);
    if (firstSlice != secondSlice) {
      isRangeOfSameSize = false;
    }
    if (firstSlice < 0 || secondSlice < 0) {
      isRangeNegative = false;
    }
    if (!isPortsOnRange) {
      ret.success = false;
      ret.message = '' + rules[i].ip +
        ': As portas devem estar na faixa entre 1 - 65535 ' +
        '(Por particularidades de aplicações do dispositivo TR-069 ' +
        'as seguintes portas também não são permitidas : ' +
        '22, 23, 80, 443, 7547 e 58000)';
      return ret;
    }
    if (!isPortsNotEmpty) {
      ret.success = false;
      ret.message = ''+rules[i].ip+': Os campos devem ser preenchidos';
      return ret;
    }
    if (!isRangeOfSameSize) {
      ret.success = false;
      ret.message = ''+rules[i].ip+
        ': As faixas de portas são de tamanhos diferentes';
      return ret;
    }
    if (!isRangeNegative) {
      ret.success = false;
      ret.message = ''+rules[i].ip+
        ': As faixas de portas estão com limites invertidos';
      return ret;
    }
    if (!isOnSubnetRange) {
      ret.success = false;
      ret.message = ''+rules[i].ip+' está fora da faixa de subrede';
      return ret;
    }
  }
  // check overlapping port mapping
  if (deviceListController.checkOverlappingPorts(rules)) {
    ret.success = false;
    ret.message = 'Possui mapeamento sobreposto';
    return ret;
  }
  // check compatibility in mode of port mapping
  if (deviceListController.checkIncompatibility(rules, DeviceVersion.
  getPortForwardTr069Compatibility(device.model, device.version))) {
    ret.success = false;
    ret.message = 'Possui regra não compatível';
    return ret;
  }
  // get the difference of length between new entries and old entries
  diffPortForwardLength = rules.length - device.port_mapping.length;
  // passed by validations, json is clean to put in the document
  device.port_mapping = rules;
  // push a hash from rules json
  device.forward_index = crypto.createHash('md5').
  update(JSON.stringify(content)).digest('base64');
  await device.save(function(err) {
    let ret = {};
    if (err) {
      console.log('Error Saving Port Forward: '+err);
      ret.success = false;
      ret.message = 'Erro ao salvar regras no servidor';
      return ret;
    }
    // geniacs-api call
    acsDeviceInfo.changePortForwardRules(device, diffPortForwardLength);
  });
  ret.success = true;
  ret.message = 'Mapeamento de portas no dispositivo '+
    device.acs_id+
    ' salvo com sucesso';
  return ret;
};

deviceListController.setPortForward = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  async function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({
        success: false,
        message: 'Erro interno do servidor',
      });
    }
    if (matchedDevice == null) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }
    let permissions = DeviceVersion.findByVersion(
      matchedDevice.version, matchedDevice.wifi_is_5ghz_capable,
      matchedDevice.model);
    if (!permissions.grantPortForward) {
      return res.status(200).json({
        success: false,
        message: 'CPE não possui essa função',
      });
    }
    if (matchedDevice.bridge_mode_enabled) {
      return res.status(200).json({
        success: false,
        message: 'Este CPE está em modo bridge, e portanto não pode '+
                 'liberar acesso a portas',
      });
    }
    // tr-069 routers
    if (matchedDevice.use_tr069) {
      let result = await deviceListController.
      setPortForwardTr069(matchedDevice,
        req.body.content);
      return res.status(200).json({
        success: result.success,
        message: result.message,
      });
    // vanilla routers
    } else {
      console.log('Updating Port Forward for ' + matchedDevice._id);
      if (util.isJsonString(req.body.content)) {
        let content = JSON.parse(req.body.content);

        let usedAsymPorts = [];

        content.forEach((r) => {
          let macRegex = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;

          if (!r.hasOwnProperty('mac') ||
              !r.hasOwnProperty('dmz') ||
              !r.mac.match(macRegex)) {
            return res.status(200).json({
              success: false,
              message: 'Dados de Endereço MAC do Dispositivo Invalidos No JSON',
            });
          }

          if (!r.hasOwnProperty('port') || !Array.isArray(r.port) ||
            !(r.port.map((p) => parseInt(p)).every((p) => (p >= 1 && p <= 65535)))
          ) {
            return res.status(200).json({
              success: false,
              message: 'Portas Internas de Dispositivo invalidas no JSON',
            });
          }

          let localPorts = r.port.map((p) => parseInt(p));
            // Get unique port set
          let localUniquePorts = [...new Set(localPorts)];

          if (r.hasOwnProperty('router_port')) {
            if (!permissions.grantPortForwardAsym) {
              return res.status(200).json({
                success: false,
                message: 'CPE não aceita portas assimétricas',
              });
            }

            if (!Array.isArray(r.router_port) ||
              !(r.router_port.map((p) => parseInt(p)).every(
                  (p) => (p >= 1 && p <= 65535)
                )
              )
            ) {
              return res.status(200).json({
                success: false,
                message: 'Portas Externas invalidas no JSON',
              });
            }

            let localAsymPorts = r.router_port.map((p) => parseInt(p));
            // Get unique port set
            let localUniqueAsymPorts = [...new Set(localAsymPorts)];
            if (localUniqueAsymPorts.length != localAsymPorts.length) {
              return res.status(200).json({
                success: false,
                message: 'Portas Externas Repetidas no JSON',
              });
            }

            if (localUniqueAsymPorts.length != localUniquePorts.length) {
              return res.status(200).json({
                success: false,
                message: 'Portas Internas e Externas não conferem no JSON',
              });
            }

            if (!(localUniqueAsymPorts.every((p) => (!usedAsymPorts.includes(p))))
            ) {
              return res.status(200).json({
                success: false,
                message: 'Portas Externas Repetidas no JSON',
              });
            }

            usedAsymPorts = usedAsymPorts.concat(localUniqueAsymPorts);
          } else {
            if (!(localUniquePorts.every((p) => (!usedAsymPorts.includes(p))))) {
              return res.status(200).json({
                success: false,
                message: 'Portas Externas Repetidas no JSON',
              });
            }
            usedAsymPorts = usedAsymPorts.concat(localUniquePorts);
          }
        });

        // If we get here, all is validated!

        // Remove all old firewall rules
        for (let idx = 0; idx < matchedDevice.lan_devices.length; idx++) {
          if (matchedDevice.lan_devices[idx].port.length > 0) {
            matchedDevice.lan_devices[idx].port = [];
            matchedDevice.lan_devices[idx].router_port = [];
            matchedDevice.lan_devices[idx].dmz = false;
          }
        }

        // Update with new ones
        content.forEach((r) => {
          let newRuleMac = r.mac.toLowerCase();
          let portsArray = r.port.map((p) => parseInt(p));
          portsArray = [...new Set(portsArray)];
          let portAsymArray = [];

          if (r.hasOwnProperty('router_port')) {
            portAsymArray = r.router_port.map((p) => parseInt(p));
            portAsymArray = [...new Set(portAsymArray)];
          }

          let newLanDevice = true;
          for (let idx = 0; idx < matchedDevice.lan_devices.length; idx++) {
            if (matchedDevice.lan_devices[idx].mac == newRuleMac) {
              matchedDevice.lan_devices[idx].port = portsArray;
              matchedDevice.lan_devices[idx].router_port = portAsymArray;
              matchedDevice.lan_devices[idx].dmz = r.dmz;
              matchedDevice.lan_devices[idx].last_seen = Date.now();
              newLanDevice = false;
              break;
            }
          }
          if (newLanDevice) {
            matchedDevice.lan_devices.push({
              mac: newRuleMac,
              port: portsArray,
              router_port: portAsymArray,
              dmz: r.dmz,
              first_seen: Date.now(),
              last_seen: Date.now(),
            });
          }
        });

        matchedDevice.forward_index = Date.now();

        matchedDevice.save(function(err) {
          if (err) {
            console.log('Error Saving Port Forward: '+err);
            return res.status(200).json({
              success: false,
              message: 'Erro salvando regras no servidor',
            });
          }
          mqtt.anlixMessageRouterUpdate(matchedDevice._id);

          return res.status(200).json({
            success: true,
            message: '',
          });
        });
      } else {
        return res.status(200).json({
          success: false,
          message: 'Erro ao tratar JSON',
        });
      }
    }
  });
};

deviceListController.getPortForward = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({
        success: false,
        message: 'Erro interno do servidor',
      });
    }
    if (matchedDevice == null) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }
    let permissions = DeviceVersion.findByVersion(
      matchedDevice.version, matchedDevice.wifi_is_5ghz_capable,
      matchedDevice.model);
    if (!permissions.grantPortForward) {
      return res.status(200).json({
        success: false,
        message: 'CPE não possui essa função',
      });
    }

    if (matchedDevice.use_tr069) {
      return res.status(200).json({
        success: true,
        content: matchedDevice.port_mapping,
        compatibility: DeviceVersion.
        getPortForwardTr069Compatibility(matchedDevice.model,
                                         matchedDevice.version),
      });
    }

    let resOut = matchedDevice.lan_devices.filter(function(lanDevice) {
      if (typeof lanDevice.port !== 'undefined' && lanDevice.port.length > 0 ) {
        return true;
      } else {
        return false;
      }
    });

    let outData = [];
    for (let i = 0; i < resOut.length; i++) {
      let tmpData = {};
      tmpData.mac = resOut[i].mac;
      tmpData.port = resOut[i].port;
      tmpData.dmz = resOut[i].dmz;

      if (('router_port' in resOut[i]) &&
          resOut[i].router_port.length != 0) {
        tmpData.router_port = resOut[i].router_port;
      }

      if (!('name' in resOut[i] && resOut[i].name == '') &&
          ('dhcp_name' in resOut[i])) {
        tmpData.name = resOut[i].dhcp_name;
      } else {
        tmpData.name = resOut[i].name;
      }
      // Check if device has IPv6 through DHCP
      tmpData.has_dhcpv6 = (Array.isArray(resOut[i].dhcpv6) &&
                            resOut[i].dhcpv6.length > 0 ? true : false);

      outData.push(tmpData);
    }

    return res.status(200).json({
      success: true,
      landevices: outData,
    });
  });
};

deviceListController.getPingHostsList = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({
        success: false,
        message: 'Erro interno do servidor',
      });
    }
    if (matchedDevice == null) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }
    return res.status(200).json({
      success: true,
      ping_hosts_list: matchedDevice.ping_hosts,
    });
  });
};

deviceListController.setPingHostsList = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({
        success: false,
        message: 'Erro interno do servidor',
      });
    }
    if (matchedDevice == null) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }
    console.log('Updating hosts ping list for ' + matchedDevice._id);
    if (util.isJsonString(req.body.content)) {
      let content = JSON.parse(req.body.content);
      let approvedHosts = [];
      content.hosts.forEach((host) => {
        let fqdnLengthRegex = /^([0-9A-Za-z]{1,63}\.){0,3}([0-9A-Za-z]{1,62})$/;
        host = host.toLowerCase();
        if (host.match(fqdnLengthRegex)) {
          approvedHosts.push(host);
        }
      });
      matchedDevice.ping_hosts = approvedHosts;
      matchedDevice.save(function(err) {
        if (err) {
          return res.status(200).json({
            success: false,
            message: 'Erro interno do servidor',
          });
        }
        return res.status(200).json({
          success: true,
          hosts: approvedHosts,
        });
      });
    } else {
      return res.status(200).json({
        success: false,
        message: 'Erro ao tratar JSON',
      });
    }
  });
};

deviceListController.getLanDevices = async function(req, res) {
  try {
    let matchedDevice = await DeviceModel.findById(req.params.id.toUpperCase());
    if (matchedDevice == null) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }

    let enrichedLanDevs = util.deepCopyObject(matchedDevice.lan_devices)
    .map((lanDevice) => {
      lanDevice.is_old = deviceHandlers.isDeviceTooOld(lanDevice.last_seen);
      lanDevice.is_online = deviceHandlers.isOnline(lanDevice.last_seen);
      // Ease up gateway reference when in Mesh mode
      lanDevice.gateway_mac = matchedDevice._id;
      return lanDevice;
    });

    let onlyOldMeshRoutersEntries = true;
    let enrichedMeshRouters = util.deepCopyObject(matchedDevice.mesh_routers)
    .filter((meshRouter) => {
      // Remove entries related to wireless connection if cabled mesh only mode
      if (matchedDevice.mesh_mode === 1 && meshRouter.iface !== 1) {
        return false;
      } else {
        return true;
      }
    })
    .map((meshRouter) => {
      meshRouter.is_old = deviceHandlers.isApTooOld(meshRouter.last_seen);
      // There is at least one updated entry
      if (!meshRouter.is_old) {
        onlyOldMeshRoutersEntries = false;
      }
      return meshRouter;
    });
    // If mesh routers list is empty or old and there are routers in mesh then
    // let's check if it's possible to populate mesh routers list by cabled
    // connections
    if (onlyOldMeshRoutersEntries || (matchedDevice.mesh_mode === 1)) {
      let meshEntry = {
        mac: '',
        last_seen: Date.now(),
        conn_time: 0,
        rx_bytes: 0,
        tx_bytes: 0,
        signal: 0,
        rx_bit: 0,
        tx_bit: 0,
        latency: 0,
        iface: 1,
      };
      if (matchedDevice.mesh_master) { // Slave router
        let masterId = matchedDevice.mesh_master.toUpperCase();
        let matchedMaster = await DeviceModel.findById(
          masterId,
          {last_contact: true,
           _id: true,
           wan_negociated_speed: true,
          }).lean();
        // If there is recent comm assume there is a cabled connection
        if (!deviceHandlers.isApTooOld(matchedMaster.last_contact)) {
          meshEntry.mac = matchedMaster._id;
          meshEntry.rx_bit = matchedMaster.wan_negociated_speed;
          meshEntry.tx_bit = matchedMaster.wan_negociated_speed;
          enrichedMeshRouters.push(meshEntry);
        }
      } else if (matchedDevice.mesh_slaves) { // Master router
        for (let slaveMac of matchedDevice.mesh_slaves) {
          let slaveId = slaveMac.toUpperCase();
          let matchedSlave = await DeviceModel.findById(
            slaveId,
            {last_contact: true,
             _id: true,
             wan_negociated_speed: true,
            }).lean();
          // If there is recent comm assume there is a cabled connection
          if (!deviceHandlers.isApTooOld(matchedSlave.last_contact)) {
            meshEntry.mac = matchedSlave._id;
            meshEntry.rx_bit = matchedSlave.wan_negociated_speed;
            meshEntry.tx_bit = matchedSlave.wan_negociated_speed;
            enrichedMeshRouters.push(meshEntry);
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      lan_devices: enrichedLanDevs,
      mesh_routers: enrichedMeshRouters,
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      success: false,
      message: 'Erro interno do servidor',
    });
  }
};

deviceListController.getSiteSurvey = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(),
  function(err, matchedDevice) {
    if (err) {
      return res.status(200).json({
        success: false,
        message: 'Erro interno do servidor',
      });
    }
    if (matchedDevice == null) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }

    let enrichedSiteSurvey = util.deepCopyObject(matchedDevice.ap_survey)
    .map((apDevice) => {
      apDevice.is_old = deviceHandlers.isApTooOld(apDevice.last_seen);
      return apDevice;
    });

    return res.status(200).json({
      success: true,
      ap_devices: enrichedSiteSurvey,
      wifi_last_channel: matchedDevice.wifi_last_channel,
      wifi_last_channel_5ghz: matchedDevice.wifi_last_channel_5ghz,
    });
  });
};

deviceListController.getSpeedtestResults = function(req, res) {
  DeviceModel.findById(req.params.id.toUpperCase(), (err, matchedDevice)=>{
    if (err) {
      return res.status(500).json({
        success: false,
        type: 'danger',
        message: 'Erro interno do servidor',
      });
    }
    if (!matchedDevice) {
      return res.status(404).json({
        success: false,
        type: 'danger',
        message: 'CPE não encontrado',
      });
    }

    let permissions = DeviceVersion.findByVersion(
      matchedDevice.version,
      matchedDevice.wifi_is_5ghz_capable,
      matchedDevice.model,
    );

    return res.status(200).json({
      success: true,
      measures: matchedDevice.speedtest_results,
      limit: permissions.grantSpeedTestLimit,
    });
  });
};

deviceListController.doSpeedTest = function(req, res) {
  let mac = req.params.id.toUpperCase();
  const isDevOn = Object.values(mqtt.unifiedClientsMap).some((map)=>{
    return map[mac];
  });
  DeviceModel.findById(mac, (err, matchedDevice)=>{
    if (err) {
      return res.status(200).json({
        success: false,
        message: 'Erro interno, por favor tente novamente',
      });
    }
    if (!matchedDevice) {
      return res.status(200).json({
        success: false,
        message: 'CPE não encontrado',
      });
    }
    if (!isDevOn) {
      return res.status(200).json({
        success: false,
        message: 'CPE não está online!',
      });
    }
    let permissions = DeviceVersion.findByVersion(
      matchedDevice.version,
      matchedDevice.wifi_is_5ghz_capable,
      matchedDevice.model,
    );
    if (!permissions.grantSpeedTest) {
      return res.status(200).json({
        success: false,
        message: 'CPE não suporta este comando',
      });
    }
    Config.findOne({is_default: true}, function(err, matchedConfig) {
      if (err || !matchedConfig) {
        return res.status(200).json({
          success: false,
          message: 'Erro interno, por favor tente novamente',
        });
      }
      if (!matchedConfig.measureServerIP) {
        return res.status(200).json({
          success: false,
          message: 'Este serviço não foi configurado pelo administrador',
        });
      }
      let url = matchedConfig.measureServerIP + ':' +
                matchedConfig.measureServerPort;
      if (req.sessionID && sio.anlixConnections[req.sessionID]) {
        sio.anlixWaitForSpeedTestNotification(req.sessionID, mac);
      }
      mqtt.anlixMessageRouterSpeedTest(mac, url, req.user);
      return res.status(200).json({
        success: true,
      });
    });
  });
};

deviceListController.setDeviceCrudTrap = function(req, res) {
  // Store callback URL for devices
  Config.findOne({is_default: true}, function(err, matchedConfig) {
    if (err || !matchedConfig) {
      return res.status(500).json({
        success: false,
        message: 'Erro ao acessar dados na base',
      });
    } else {
      matchedConfig.traps_callbacks.device_crud.url = req.body.url;
      if ('user' in req.body && 'secret' in req.body) {
        matchedConfig.traps_callbacks.device_crud.user = req.body.user;
        matchedConfig.traps_callbacks.device_crud.secret = req.body.secret;
      }
      matchedConfig.save((err) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Erro ao gravar dados na base',
          });
        }
        return res.status(200).json({
          success: true,
          message: 'Endereço salvo com sucesso',
        });
      });
    }
  });
};

deviceListController.setLanDeviceBlockState = function(req, res) {
  DeviceModel.findById(req.body.id, function(err, matchedDevice) {
    if (err || !matchedDevice) {
      return res.status(500).json({success: false,
                                   message: 'Erro ao encontrar CPE'});
    }
    let devFound = false;
    for (let idx = 0; idx < matchedDevice.lan_devices.length; idx++) {
      if (matchedDevice.lan_devices[idx].mac === req.body.lanid) {
        matchedDevice.lan_devices[idx].is_blocked = req.body.isblocked;
        matchedDevice.blocked_devices_index = Date.now();
        devFound = true;
        break;
      }
    }
    if (devFound) {
      matchedDevice.save(function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Erro ao registrar atualização'});
        }
        mqtt.anlixMessageRouterUpdate(matchedDevice._id);

        return res.status(200).json({'success': true});
      });
    } else {
      return res.status(500).json({success: false,
                                   message: 'Erro ao encontrar dispositivo'});
    }
  });
};

deviceListController.updateLicenseStatus = async function(req, res) {
  try {
    let matchedDevice = await DeviceModel.findById(req.body.id);
    if (!matchedDevice) {
      return res.status(500).json({success: false,
                                   message: 'Erro ao encontrar CPE'});
    }
    let retObj = await controlApi.getLicenseStatus(req.app, matchedDevice);
    if (retObj.success) {
      if (matchedDevice.is_license_active === undefined) {
        matchedDevice.is_license_active = !retObj.isBlocked;
        await matchedDevice.save();
      } else if ((!retObj.isBlocked) !== matchedDevice.is_license_active) {
        matchedDevice.is_license_active = !retObj.isBlocked;
        await matchedDevice.save();
      }
      return res.json({success: true, status: !retObj.isBlocked});
    } else {
      return res.json({success: false, message: retObj.message});
    }
  } catch (err) {
    return res.status(500).json({success: false,
                                 message: 'Erro externo de comunicação'});
  }
};

deviceListController.receivePonSignalMeasure = async function(req, res) {
  let deviceId = req.params.deviceId;

  DeviceModel.findById(deviceId, function(err, matchedDevice) {
    if (err) {
      return res.status(400).json({processed: 0, success: false});
    }
    if (!matchedDevice) {
      return res.status(404).json({success: false,
                                   message: 'ONU não encontrada'});
    }
    if (!matchedDevice.use_tr069) {
      return res.status(404).json({success: false,
                                   message: 'ONU não encontrada'});
    }
    let mac = matchedDevice._id;
    let acsID = matchedDevice.acs_id;
    let splitID = acsID.split('-');
    let model = splitID.slice(1, splitID.length-1).join('-');
    let fields = DevicesAPI.getModelFields(splitID[0], model).fields;
    let rxPowerField = fields.wan.pon_rxpower;
    let txPowerField = fields.wan.pon_txpower;
    let task = {
      name: 'getParameterValues',
      parameterNames: [rxPowerField, txPowerField],
    };

    sio.anlixWaitForPonSignalNotification(req.sessionID, mac);

    res.status(200).json({success: true});
    TasksAPI.addTask(acsID, task, true, 3000, [5000, 10000], (result)=>{
      if (result.task.name !== 'getParameterValues') return;
      if (result.finished) {
        acsDeviceInfo.fetchPonSignalFromGenie(mac, acsID);
      }
    });
  });
};

deviceListController.exportDevicesCsv = async function(req, res) {
  let queryContents = req.query.filter.split(',');

  try {
    const userRole = await Role.findOne({
      name: util.returnObjOrEmptyStr(req.user.role)});
    let finalQuery;
    if (req.user.is_superuser || userRole.grantSearchLevel >= 2) {
      finalQuery = await deviceListController.complexSearchDeviceQuery(
        queryContents);
    } else {
      finalQuery = deviceListController.simpleSearchDeviceQuery(
        queryContents);
    }

    let devices = {};
    devices = await DeviceModel.find(finalQuery).lean();

    let exportPasswords = (req.user.is_superuser || userRole.grantPassShow ?
                           true : false);
    const csvFields = [
      {label: 'Endereço MAC', value: '_id'},
      {label: 'Identificador Serial', value: 'serial_tr069'},
      {label: 'Tipo de Conexão WAN', value: 'connection_type'},
      {label: 'Usuário PPPoE', value: 'pppoe_user'},
    ];
    if (exportPasswords) {
      csvFields.push({label: 'Senha PPPoE', value: 'pppoe_password'});
    }
    csvFields.push(
      {label: 'Subrede LAN', value: 'lan_subnet'},
      {label: 'Máscara LAN', value: 'lan_netmask'},
      {label: 'Wi-Fi SSID', value: 'wifi_ssid'},
    );
    if (exportPasswords) {
      csvFields.push({label: 'Wi-Fi Senha', value: 'wifi_password'});
    }
    csvFields.push(
      {label: 'Wi-Fi Canal', value: 'wifi_channel'},
      {label: 'Largura de banda', value: 'wifi_band'},
      {label: 'Modo de operação', value: 'wifi_mode'},
      {label: 'Wi-Fi SSID 5GHz', value: 'wifi_ssid_5ghz'},
    );
    if (exportPasswords) {
      csvFields.push({label: 'Wi-Fi Senha 5GHz', value: 'wifi_password_5ghz'});
    }
    csvFields.push(
      {label: 'Wi-Fi Canal 5GHz', value: 'wifi_channel_5ghz'},
      {label: 'Largura de banda 5GHz', value: 'wifi_band_5ghz'},
      {label: 'Modo de operação 5GHz', value: 'wifi_mode_5ghz'},
      {label: 'IP Público', value: 'ip'},
      {label: 'IP WAN', value: 'wan_ip'},
      {label: 'Velocidade WAN negociada', value: 'wan_negociated_speed'},
      {label: 'Modo de transmissão WAN (duplex)',
              value: 'wan_negociated_duplex'},
      {label: 'Tipo de ID do cliente', value: 'external_reference.kind'},
      {label: 'ID do cliente', value: 'external_reference.data'},
      {label: 'Modelo do CPE', value: 'model'},
      {label: 'Versão do firmware', value: 'version'},
      {label: 'Release', value: 'installed_release'},
      {label: 'Atualizar firmware', value: 'do_update'},
    );
    const json2csvParser = new Parser({fields: csvFields});
    const devicesCsv = json2csvParser.parse(devices);
    res.set('Content-Type', 'text/csv');
    return res.send(devicesCsv);
  } catch (err) {
    let emptyReturn = '';
    res.set('Content-Type', 'text/csv');
    return res.send(emptyReturn);
  }
};

module.exports = deviceListController;
