
const DeviceModel = require('../models/device');
const Config = require('../models/config');
const mqtt = require('../mqtts');
const sio = require('../sio');
const Validator = require('../public/javascripts/device_validator');
let deviceInfoController = {};

const returnObjOrEmptyStr = function(query) {
  if (typeof query !== 'undefined' && query) {
    return query;
  } else {
    return '';
  }
};

const createRegistry = function(req, res) {
  if (typeof req.body.id == 'undefined') {
    return res.status(400).end(); ;
  }

  const validator = new Validator();
  const macAddr = req.body.id.trim().toUpperCase();

  let errors = [];
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  let wanIp = returnObjOrEmptyStr(req.body.wan_ip).trim();
  let release = returnObjOrEmptyStr(req.body.release_id).trim();
  let model = returnObjOrEmptyStr(req.body.model).trim() +
              returnObjOrEmptyStr(req.body.model_ver).trim();
  let version = returnObjOrEmptyStr(req.body.version).trim();
  let connectionType = returnObjOrEmptyStr(req.body.connection_type).trim();
  let pppoeUser = returnObjOrEmptyStr(req.body.pppoe_user).trim();
  let pppoePassword = returnObjOrEmptyStr(req.body.pppoe_password).trim();
  let ssid = returnObjOrEmptyStr(req.body.wifi_ssid).trim();
  let password = returnObjOrEmptyStr(req.body.wifi_password).trim();
  let channel = returnObjOrEmptyStr(req.body.wifi_channel).trim();
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

  Config.findOne({is_default: true}, function(err, matchedConfig) {
    if (err || !matchedConfig) {
      console.log('Error creating entry: ' + err);
      return res.status(500).end();
    }

    // Validate fields
    genericValidate(macAddr, validator.validateMac, 'mac');
    if (connectionType != 'pppoe' && connectionType != 'dhcp' &&
        connectionType != '') {
      return res.status(500);
    }
    if (pppoe) {
      genericValidate(pppoeUser, validator.validateUser, 'pppoe_user');
      genericValidate(pppoePassword, validator.validatePassword,
                      'pppoe_password', matchedConfig.pppoePassLength);
    }
    genericValidate(ssid, validator.validateSSID, 'ssid');
    genericValidate(password, validator.validateWifiPassword, 'password');
    genericValidate(channel, validator.validateChannel, 'channel');

    if (errors.length < 1) {
      newDeviceModel = new DeviceModel({
        '_id': macAddr,
        'model': model,
        'version': version,
        'release': release,
        'pppoe_user': pppoeUser,
        'pppoe_password': pppoePassword,
        'wifi_ssid': ssid,
        'wifi_password': password,
        'wifi_channel': channel,
        'wan_ip': wanIp,
        'ip': ip,
        'last_contact': Date.now(),
        'do_update': false,
        'do_update_parameters': false,
      });
      if (connectionType != '') {
        newDeviceModel.connection_type = connectionType;
      }
      newDeviceModel.save(function(err) {
        if (err) {
          console.log('Error creating entry: ' + err);
          return res.status(500).end();
        } else {
          return res.status(200).json({'do_update': false,
                                       'do_newprobe': true,
                                       'release_id:': release});
        }
      });
    } else {
      return res.status(500).end(); ;
    }
  });
};

const isJSONObject = function(val) {
  return val instanceof Object ? true : false;
};

const serializeBlocked = function(devices) {
  if (!devices) return [];
  return devices.map((device)=>device.mac + '|' + device.id);
};

const serializeNamed = function(devices) {
  if (!devices) return [];
  return devices.map((device)=>device.mac + '|' + device.name);
};

const deepCopyObject = function(obj) {
  return JSON.parse(JSON.stringify(obj));
};

deviceInfoController.syncDate = function(req, res) {
  // WARNING: This api is open.
  let devId;
  if (req.body.id) {
    if (req.body.id.trim().length == 17) {
      devId = req.body.id.trim().toUpperCase();
    }
  } else {
    devId = '';
  }

  let devNtp;
  if (req.body.ntp) {
    if (req.body.ntp.trim().length <= 12) {
      devNtp = req.body.ntp.trim();
    }
  } else {
    devNtp = '';
  }

  let devDate;
  if (req.body.date) {
    if (req.body.date.trim().length <= 14) {
      devDate = req.body.date.trim();
    }
  } else {
    devDate = '';
  }

  console.log('Request Date from '+ devId +': NTP '+ devNtp +' Date '+ devDate);

  let parsedate = parseInt(devDate);
  if (!isNaN(parsedate)) {
    let locDate = new Date(parsedate*1000);
    let atDate = Date.now();
    let diffDate = atDate - locDate;
    // adjust router clock if difference is more than
    // a minute ahead or more than an hour behind
    let serverDate = Math.floor(Date.now() / 1000);
    if ((diffDate < -(60*1000)) || (diffDate>(60*60*1000))) {
      res.status(200).json({'need_update': 1, 'new_date': serverDate});
    } else {
      res.status(200).json({'need_update': 0, 'new_date': serverDate});
    }
  } else {
    res.status(500).end();
  }
};


// Create new device entry or update an existing one
deviceInfoController.updateDevicesInfo = function(req, res) {
  if (process.env.FLM_BYPASS_SECRET == undefined) {
    if (req.body.secret != req.app.locals.secret) {
      console.log('Error in SYN: Secret not match!');
      return res.status(404).end(); ;
    }
  }

  let devId = req.body.id.toUpperCase();
  DeviceModel.findById(devId, function(err, matchedDevice) {
    if (err) {
      console.log('Error finding device '+devId+': ' + err);
      return res.status(500).end(); ;
    } else {
      if (matchedDevice == null) {
        createRegistry(req, res);
      } else {
        let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        // Update old entries
        if (!matchedDevice.get('do_update_parameters')) {
          matchedDevice.do_update_parameters = false;
        }

        // Parameters only modified on first comm between device and flashman
        if (matchedDevice.model == '' ||
          matchedDevice.model == returnObjOrEmptyStr(req.body.model).trim()
        ) {
          // Legacy versions include only model so let's include model version
          matchedDevice.model = returnObjOrEmptyStr(req.body.model).trim() +
                                returnObjOrEmptyStr(req.body.model_ver).trim();
        }

        let sentVersion = returnObjOrEmptyStr(req.body.version).trim();
        if (matchedDevice.version != sentVersion) {
          console.log('Device '+ devId +' changed version to: '+ sentVersion);
          matchedDevice.version = sentVersion;
        }

        let sentNtp = returnObjOrEmptyStr(req.body.ntp).trim();
        if (matchedDevice.ntp_status != sentNtp) {
          console.log('Device '+ devId +' changed NTP STATUS to: '+ sentNtp);
          matchedDevice.ntp_status = sentNtp;
        }

        // Parameters *NOT* available to be modified by REST API
        matchedDevice.wan_ip = returnObjOrEmptyStr(req.body.wan_ip).trim();
        matchedDevice.ip = ip;
        matchedDevice.last_contact = Date.now();

        let hardReset = returnObjOrEmptyStr(req.body.hardreset).trim();
        if (hardReset == '1') {
          matchedDevice.last_hardreset = Date.now();
        }

        let upgradeInfo = returnObjOrEmptyStr(req.body.upgfirm).trim();
        if (upgradeInfo == '1') {
          if (matchedDevice.do_update) {
            console.log('Device '+devId+' upgraded successfuly');
            matchedDevice.do_update = false;
          } else {
            console.log(
              'WARNING: Device ' + devId +
              ' sent a upgrade ack but was not marked as upgradable!'
            );
          }
        }

        let sentRelease = returnObjOrEmptyStr(req.body.release_id).trim();
        if (matchedDevice.release != sentRelease) {
          if (matchedDevice.do_update) {
            console.log(
              'Device '+ devId +' reported release as '+ sentRelease +
              ', but is expect to change to '+ matchedDevice.release
            );
          } else {
            console.log(
              'Device ' + devId + ' changed release to: ' + sentRelease
            );
            matchedDevice.release = sentRelease;
          }
        }

        let flmUpdater = returnObjOrEmptyStr(req.body.flm_updater).trim();
        if (flmUpdater == '1' || flmUpdater == '') {
          // The syn came from flashman_updater (or old routers...)

          // We can disable since the device will receive the update
          matchedDevice.do_update_parameters = false;

          // Remove notification to device using MQTT
          mqtt.anlix_message_router_reset(matchedDevice._id);
        }

        matchedDevice.save();
        return res.status(200).json({
          'do_update': matchedDevice.do_update,
          'do_newprobe': false,
          'mqtt_status': (matchedDevice._id in mqtt.clients),
          'release_id': returnObjOrEmptyStr(matchedDevice.release),
          'connection_type': returnObjOrEmptyStr(matchedDevice.connection_type),
          'pppoe_user': returnObjOrEmptyStr(matchedDevice.pppoe_user),
          'pppoe_password': returnObjOrEmptyStr(matchedDevice.pppoe_password),
          'wifi_ssid': returnObjOrEmptyStr(matchedDevice.wifi_ssid),
          'wifi_password': returnObjOrEmptyStr(matchedDevice.wifi_password),
          'wifi_channel': returnObjOrEmptyStr(matchedDevice.wifi_channel),
          'app_password': returnObjOrEmptyStr(matchedDevice.app_password),
          'blocked_devices': serializeBlocked(matchedDevice.blocked_devices),
          'named_devices': serializeNamed(matchedDevice.named_devices),
          'forward_index': returnObjOrEmptyStr(matchedDevice.forward_index),
        });
      }
    }
  });
};

// Receive device firmware upgrade confirmation
deviceInfoController.confirmDeviceUpdate = function(req, res) {
  DeviceModel.findById(req.body.id, function(err, matchedDevice) {
    if (err) {
      console.log('Error finding device: ' + err);
      return res.status(500).end();
    } else {
      if (matchedDevice == null) {
        return res.status(500).end();
      } else {
        let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        matchedDevice.ip = ip;
        matchedDevice.last_contact = Date.now();
        let upgStatus = returnObjOrEmptyStr(req.body.status).trim();
        if (upgStatus == '1') {
          console.log('Device '+req.body.id+' is going on upgrade...');
        } else if (upgStatus == '0') {
          console.log('WARNING: Device ' + req.body.id +
                      ' failed in firmware check!');
        } else if (upgStatus == '2') {
          console.log('WARNING: Device ' + req.body.id +
                      ' failed to download firmware!');
        } else if (upgStatus == '') {
          console.log('WARNING: Device ' + req.body.id +
                      ' ack update on an old firmware! Reseting upgrade...');
          matchedDevice.do_update = false;
        }

        matchedDevice.save();
        return res.status(200).end();
      }
    }
  });
};

deviceInfoController.registerMqtt = function(req, res) {
  if (req.body.secret == req.app.locals.secret) {
    DeviceModel.findById(req.body.id, function(err, matchedDevice) {
      if (err) {
        console.log('Attempt to register MQTT secret for device ' +
          req.body.id + ' failed: Cant get device profile.');
        return res.status(400).json({is_registered: 0});
      }
      if (!matchedDevice) {
        console.log('Attempt to register MQTT secret for device ' +
          req.body.id + ' failed: No device found.');
        return res.status(404).json({is_registered: 0});
      }
      if (!matchedDevice.mqtt_secret) {
        matchedDevice.mqtt_secret = req.body.mqttsecret;
        matchedDevice.save();
        console.log('Device ' +
          req.body.id + ' register MQTT secret successfully.');
        return res.status(200).json({is_registered: 1});
      } else {
        // Device have a secret. Modification of secret is forbidden!
        console.log('Attempt to register MQTT secret for device ' +
          req.body.id + ' failed: Device have a secret.');
        return res.status(404).json({is_registered: 0});
      }
    });
  } else {
    console.log('Attempt to register MQTT secret for device ' +
      req.body.id + ' failed: Client Secret not match!');
    return res.status(401).json({is_registered: 0});
  }
};

deviceInfoController.registerApp = function(req, res) {
  if (req.body.secret == req.app.locals.secret) {
    DeviceModel.findById(req.body.id, function(err, matchedDevice) {
      if (err) {
        return res.status(400).json({is_registered: 0});
      }
      if (!matchedDevice) {
        return res.status(404).json({is_registered: 0});
      }
      let appObj = matchedDevice.apps.filter(function(app) {
        return app.id === req.body.app_id;
      });
      if (appObj.length == 0) {
        matchedDevice.apps.push({id: req.body.app_id,
                                 secret: req.body.app_secret});
      } else {
        let objIdx = matchedDevice.apps.indexOf(appObj[0]);
        matchedDevice.apps.splice(objIdx, 1);
        appObj[0].secret = req.body.app_secret;
        matchedDevice.apps.push(appObj[0]);
      }
      matchedDevice.save();
      return res.status(200).json({is_registered: 1});
    });
  } else {
    return res.status(401).json({is_registered: 0});
  }
};

deviceInfoController.registerPassword = function(req, res) {
  if (req.body.secret == req.app.locals.secret) {
    DeviceModel.findById(req.body.id, function(err, matchedDevice) {
      if (err) {
        return res.status(400).json({is_registered: 0});
      }
      if (!matchedDevice) {
        return res.status(404).json({is_registered: 0});
      }
      let appObj = matchedDevice.apps.filter(function(app) {
        return app.id === req.body.app_id;
      });
      if (appObj.length == 0) {
        return res.status(404).json({is_set: 0});
      }
      if (appObj[0].secret != req.body.app_secret) {
        return res.status(403).json({is_set: 0});
      }
      matchedDevice.app_password = req.body.router_passwd;
      matchedDevice.save();
      return res.status(200).json({is_registered: 1});
    });
  } else {
    return res.status(401).json({is_registered: 0});
  }
};

deviceInfoController.removeApp = function(req, res) {
  if (req.body.secret == req.app.locals.secret) {
    DeviceModel.findById(req.body.id, function(err, matchedDevice) {
      if (err) {
        return res.status(400).json({is_unregistered: 0});
      }
      if (!matchedDevice) {
        return res.status(404).json({is_unregistered: 0});
      }
      let appsFiltered = matchedDevice.apps.filter(function(app) {
        return app.id !== req.body.app_id;
      });
      matchedDevice.apps = appsFiltered;
      matchedDevice.save();
      return res.status(200).json({is_unregistered: 1});
    });
  } else {
    return res.status(401).json({is_unregistered: 0});
  }
};

let checkUpdateParametersDone = function(id, ncalls, maxcalls) {
  return new Promise((resolve, reject)=>{
    DeviceModel.findById(id, (err, matchedDevice)=>{
      if (err || !matchedDevice) return reject();
      resolve(!matchedDevice.do_update_parameters);
    });
  }).then((done)=>{
    if (done) return Promise.resolve(true);
    if (ncalls >= maxcalls) return Promise.resolve(false);
    return new Promise((resolve, reject)=>{
      setTimeout(()=>{
        checkUpdateParametersDone(id, ncalls+1, maxcalls).then(resolve, reject);
      }, 1000);
    });
  }, (rejectedVal)=>{
    return Promise.reject(rejectedVal);
  });
};

let doRollback = function(device, values) {
  for (let key in values) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      device[key] = values[key];
    }
  }
};

let appSet = function(req, res, processFunction) {
  DeviceModel.findById(req.body.id, function(err, matchedDevice) {
    if (err) {
      return res.status(400).json({is_set: 0});
    }
    if (!matchedDevice) {
      return res.status(404).json({is_set: 0});
    }
    let appObj = matchedDevice.apps.filter(function(app) {
      return app.id === req.body.app_id;
    });
    if (appObj.length == 0) {
      return res.status(404).json({is_set: 0});
    }
    if (appObj[0].secret != req.body.app_secret) {
      return res.status(404).json({is_set: 0});
    }

    if (isJSONObject(req.body.content)) {
      let content = req.body.content;
      let rollbackValues = {};

      if (processFunction(content, matchedDevice, rollbackValues)) {
        matchedDevice.do_update_parameters = true;
      }

      let hashSuffix = '';
      let commandTimeout = 10;
      if (content.hasOwnProperty('command_hash')) {
        hashSuffix = ' ' + content.command_hash;
      }
      if (content.hasOwnProperty('command_timeout')) {
        commandTimeout = content.command_timeout;
      }

      matchedDevice.save();

      mqtt.anlix_message_router_update(matchedDevice._id, hashSuffix);

      checkUpdateParametersDone(matchedDevice._id, 0, commandTimeout)
      .then((done)=>{
        if (done) return res.status(200).json({is_set: 1});
        doRollback(matchedDevice, rollbackValues);
        matchedDevice.save();
        return res.status(500).json({is_set: 0});
      }, (rejectedVal)=>{
        doRollback(matchedDevice, rollbackValues);
        matchedDevice.save();
        return res.status(500).json({is_set: 0});
      });
    } else {
      return res.status(500).json({is_set: 0});
    }
  });
};

deviceInfoController.appSetWifi = function(req, res) {
  let processFunction = (content, device, rollback) => {
    let updateParameters = false;
    if (content.hasOwnProperty('pppoe_user')) {
      rollback.pppoe_user = device.pppoe_user;
      device.pppoe_user = content.pppoe_user;
      updateParameters = true;
    }
    if (content.hasOwnProperty('pppoe_password')) {
      rollback.pppoe_password = device.pppoe_password;
      device.pppoe_password = content.pppoe_password;
      updateParameters = true;
    }
    if (content.hasOwnProperty('wifi_ssid')) {
      rollback.wifi_ssid = device.wifi_ssid;
      device.wifi_ssid = content.wifi_ssid;
      updateParameters = true;
    }
    if (content.hasOwnProperty('wifi_password')) {
      rollback.wifi_password = device.wifi_password;
      device.wifi_password = content.wifi_password;
      updateParameters = true;
    }
    if (content.hasOwnProperty('wifi_channel')) {
      rollback.wifi_channel = device.wifi_channel;
      device.wifi_channel = content.wifi_channel;
      updateParameters = true;
    }
    return updateParameters;
  };
  appSet(req, res, processFunction);
};

deviceInfoController.appSetPassword = function(req, res) {
  let processFunction = (content, device, rollback) => {
    if (content.hasOwnProperty('app_password')) {
      rollback.app_password = device.app_password;
      device.app_password = content.app_password;
      return true;
    }
    return false;
  };
  appSet(req, res, processFunction);
};

deviceInfoController.appSetBlacklist = function(req, res) {
  let processFunction = (content, device, rollback) => {
    let macRegex = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;
    if (content.hasOwnProperty('blacklist_device') &&
        content.blacklist_device.hasOwnProperty('mac') &&
        content.blacklist_device.mac.match(macRegex)) {
      // Deep copy blocked devices for rollback
      rollback.blocked_devices = deepCopyObject(device.blocked_devices);
      let containsMac = device.blocked_devices.reduce((acc, val)=>{
        return acc || (val.mac === content.blacklist_device.mac);
      }, false);
      if (!containsMac) {
        device.blocked_devices.push({
          id: content.blacklist_device.id,
          mac: content.blacklist_device.mac,
        });
        return true;
      }
    }
    return false;
  };
  appSet(req, res, processFunction);
};

deviceInfoController.appSetWhitelist = function(req, res) {
  let processFunction = (content, device, rollback) => {
    let macRegex = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;
    if (content.hasOwnProperty('whitelist_device') &&
        content.whitelist_device.hasOwnProperty('mac') &&
        content.whitelist_device.mac.match(macRegex)) {
      // Deep copy blocked devices for rollback
      rollback.blocked_devices = deepCopyObject(device.blocked_devices);
      let filteredDevices = device.blocked_devices.filter((device)=>{
        return device.mac !== content.whitelist_device.mac;
      });
      if (device.blocked_devices.length !== filteredDevices.length) {
        device.blocked_devices = filteredDevices;
        return true;
      }
    }
    return false;
  };
  appSet(req, res, processFunction);
};

deviceInfoController.appSetDeviceInfo = function(req, res) {
  let processFunction = (content, device, rollback) => {
    let macRegex = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;
    if (content.hasOwnProperty('device_configs') &&
        content.device_configs.hasOwnProperty('mac') &&
        content.device_configs.mac.match(macRegex)) {
      // Deep copy named devices for rollback
      rollback.named_devices = deepCopyObject(device.named_devices);
      let namedDevices = device.named_devices;
      let newMac = true;
      namedDevices = namedDevices.map((namedDevice)=>{
        if (namedDevice.mac !== content.device_configs.mac) return namedDevice;
        newMac = false;
        namedDevice.name = content.device_configs.name;
        return namedDevice;
      });
      if (newMac) {
        namedDevices.push({
          name: content.device_configs.name,
          mac: content.device_configs.mac,
        });
      }
      device.named_devices = namedDevices;
      return true;
    }
    return false;
  };
  appSet(req, res, processFunction);
};

deviceInfoController.receiveLog = function(req, res) {
  let id = req.headers['x-anlix-id'];
  let bootType = req.headers['x-anlix-logs'];
  let envsec = req.headers['x-anlix-sec'];

  if (process.env.FLM_BYPASS_SECRET == undefined) {
    if (envsec != req.app.locals.secret) {
      console.log('Error Receiving Log: Secret not match!');
      return res.status(404).json({processed: 0});
    }
  }

  DeviceModel.findById(id, function(err, matchedDevice) {
    if (err) {
      console.log('Log Receiving for device ' +
        id + ' failed: Cant get device profile.');
      return res.status(400).json({processed: 0});
    }
    if (!matchedDevice) {
      console.log('Log Receiving for device ' +
        id + ' failed: No device found.');
      return res.status(404).json({processed: 0});
    }

    if (bootType == 'FIRST') {
      matchedDevice.firstboot_log = new Buffer(req.body);
      matchedDevice.firstboot_date = Date.now();
      matchedDevice.save();
      console.log('Log Receiving for device ' +
        id + ' successfully. FIRST BOOT');
    } else if (bootType == 'BOOT') {
      matchedDevice.lastboot_log = new Buffer(req.body);
      matchedDevice.lastboot_date = Date.now();
      matchedDevice.save();
      console.log('Log Receiving for device ' +
        id + ' successfully. LAST BOOT');
    } else if (bootType == 'LIVE') {
      sio.anlix_send_livelog_notifications(id, req.body);
      console.log('Log Receiving for device ' +
        id + ' successfully. LIVE');
    }

    return res.status(200).json({processed: 1});
  });
};

deviceInfoController.getPortForward = function(req, res) {
  if (req.body.secret == req.app.locals.secret) {
    DeviceModel.findById(req.body.id, function(err, matchedDevice) {
      if (err) {
        console.log('Router '+req.body.id+' Get Port Forwards ' +
          'failed: Cant get device profile.');
        return res.status(400).json({success: false});
      }
      if (!matchedDevice) {
        console.log('Router '+req.body.id+' Get Port Forwards ' +
          'failed: No device found.');
        return res.status(404).json({success: false});
      }
      if (matchedDevice.forward_index) {
        return res.status(200).json({
          'success': true,
          'forward_index': matchedDevice.forward_index,
          'forward_rules': matchedDevice.forward_rules,
        });
      }
    });
  } else {
    console.log('Router '+req.body.id+' Get Port Forwards ' +
      'failed: Client Secret not match!');
    return res.status(401).json({success: false});
  }
};

deviceInfoController.receiveDevices = function(req, res) {
  let id = req.headers['x-anlix-id'];
  let envsec = req.headers['x-anlix-sec'];

  if (process.env.FLM_BYPASS_SECRET == undefined) {
    if (envsec != req.app.locals.secret) {
      console.log('Error Receiving Devices: Secret not match!');
      return res.status(404).json({processed: 0});
    }
  }

  DeviceModel.findById(id, function(err, matchedDevice) {
    if (err) {
      console.log('Devices Receiving for device ' +
        id + ' failed: Cant get device profile.');
      return res.status(400).json({processed: 0});
    }
    if (!matchedDevice) {
      console.log('Devices Receiving for device ' +
        id + ' failed: No device found.');
      return res.status(404).json({processed: 0});
    }

    sio.anlix_send_onlinedev_notifications(id, req.body);
    console.log('Devices Receiving for device ' +
      id + ' successfully.');

    return res.status(200).json({processed: 1});
  });
};

module.exports = deviceInfoController;
