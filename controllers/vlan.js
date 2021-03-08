let User = require('../models/user');
let Config = require('../models/config');
let DeviceModel = require('../models/device');
const DeviceVersion = require('../models/device_version');
const Role = require('../models/role');

let vlanController = {};

vlanController.showVlanProfiles = function(req, res) {
  let indexContent = {};

  // Check Flashman automatic update availability
  if (typeof process.env.FLM_DISABLE_AUTO_UPDATE !== 'undefined' && (
             process.env.FLM_DISABLE_AUTO_UPDATE === 'true' ||
             process.env.FLM_DISABLE_AUTO_UPDATE === true)
  ) {
    indexContent.disableAutoUpdate = true;
  } else {
    indexContent.disableAutoUpdate = false;
  }

  Role.find(function(err, roles) {
    if (err) {
      console.log(err);
      indexContent.type = 'danger';
      indexContent.message = 'Permissão não encontrada';
      return res.render('error', indexContent);
    }
    let userRole = roles.find(function(role) {
      return role.name === req.user.role;
    });
    if (typeof userRole === 'undefined' && !req.user.is_superuser) {
      indexContent.type = 'danger';
      indexContent.message = 'Permissão não encontrada';
      return res.render('error', indexContent);
    } else {
      indexContent.roles = roles;
      indexContent.role = userRole;

      if (req.user.is_superuser || indexContent.role.grantVlanProfileEdit) {
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
              let active = matchedConfig.measure_configs.is_active;
                indexContent.measure_active = active;
                indexContent.measure_token = (active) ?
                    matchedConfig.measure_configs.auth_token : '';
              let license = matchedConfig.measure_configs.is_license_active;
              indexContent.measure_license = license;
            }
            indexContent.username = req.user.name;

            return res.render('showvlanprofiles', indexContent);
          });
        });
      } else {
        indexContent.type = 'danger';
        indexContent.message = 'Permissão negada';
        return res.render('error', indexContent);
      }
    }
  });
};

vlanController.getVlanProfile = function(req, res) {
  let indexContent = {};

  // Check Flashman automatic update availability
  if (typeof process.env.FLM_DISABLE_AUTO_UPDATE !== 'undefined' && (
             process.env.FLM_DISABLE_AUTO_UPDATE === 'true' ||
             process.env.FLM_DISABLE_AUTO_UPDATE === true)
  ) {
    indexContent.disableAutoUpdate = true;
  } else {
    indexContent.disableAutoUpdate = false;
  }

  Role.find(function(err, roles) {
    if (err) {
      console.log(err);
      indexContent.type = 'danger';
      indexContent.message = 'Permissão não encontrada';
      return res.render('error', indexContent);
    }
    let userRole = roles.find(function(role) {
      return role.name === req.user.role;
    });
    if (typeof userRole === 'undefined' && !req.user.is_superuser) {
      indexContent.type = 'danger';
      indexContent.message = 'Permissão não encontrada';
      return res.render('error', indexContent);
    } else {
      indexContent.roles = roles;
      indexContent.role = userRole;

      if (req.user.is_superuser || indexContent.role.grantVlanProfileEdit) {
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
              let active = matchedConfig.measure_configs.is_active;
                indexContent.measure_active = active;
                indexContent.measure_token = (active) ?
                    matchedConfig.measure_configs.auth_token : '';
              let license = matchedConfig.measure_configs.is_license_active;
              indexContent.measure_license = license;
            }
            indexContent.username = req.user.name;

            let exist_vlan_profile = false;

            for(let i = 0; i < matchedConfig.vlans_profiles.length ; i++) {
              if(matchedConfig.vlans_profiles[i].vlan_id == req.params.vid) {
                exist_vlan_profile = true;
                indexContent.vlanprofile = matchedConfig.vlans_profiles[i]; 
              }
            }

            if(exist_vlan_profile) {
              return res.render('vlanprofile', indexContent);
            }
            else {
              indexContent.type = 'danger';
              indexContent.message = 'VLAN ID não encontrado';
              return res.render('error', indexContent);
            }
          });
        });
      } else {
        indexContent.type = 'danger';
        indexContent.message = 'Permissão negada';
        return res.render('error', indexContent);
      }
    }
  });
};

vlanController.getAllVlanProfiles = function(req, res) {
  Config.findOne({is_default: true}, function(err, config) {
    if(err) {
      return res.json({success: false, type: 'danger',
                       message: 'Erro ao buscar perfis de VLAN'});
    }
    else {
      return res.json({success: true, type: 'success', vlanProfiles: config.vlans_profiles});
    }
  });
};

vlanController.addVlanProfile = async function(req, res) {
  let newVlanProfile = {vlan_id : req.body.id, profile_name : req.body.name};

  if (newVlanProfile.vlan_id != 1 && (newVlanProfile.vlan_id < 10 || newVlanProfile.vlan_id > 127)) {
    return res.json({success: false, type: 'danger', message : "O VLAN ID não pode ser menor que 10 ou maior que 127!"});
  }
  let config = await Config.findOne({is_default: true}).catch(function(rej) {
    return res.json({success: false, type: 'danger', message : rej.message});
  });
  if(config && config.vlans_profiles) {
    config.vlans_profiles.push(newVlanProfile);
    config.save().then(function() {
      return res.json({ success: true, type: 'success', message: 'Perfil de VLAN criado com sucesso!'});
    }).catch(function(rej) {
      return res.json({success: false, type: 'danger', message : rej.message});
    });
  }
  else {
    return res.json({success: false, type: 'danger', message : "Erro ao acessar a configuração ao adicionar perfil de VLAN"});
  }
};

vlanController.editVlanProfile = async function(req, res) {
  let config = await Config.findOne({is_default: true}).catch(function(rej) {
    return res.json({success: false, type: 'danger', message : rej.message});
  });
  if(config && config.vlans_profiles) {
    let exist_vlan_profile = false;
    for(let i = 0 ; i < config.vlans_profiles.length ; i++) {
      if(config.vlans_profiles[i].vlan_id == parseInt(req.params.vid)) {
        exist_vlan_profile = true;
        config.vlans_profiles[i].profile_name = req.body.profilename;
      }
    }

    if(exist_vlan_profile) {
      config.save().then(function() {
        return res.json({ success: true, type: 'success', message: 'Perfil de VLAN atualizado com sucesso!'});
      }).catch(function(rej) {
        return res.json({success: false, type: 'danger', message : rej.message});
      });
    }
    else {
      return res.json({success: false, type: 'danger', message : "VLAN ID não foi encontrado!"});
    }
  }
  else {
    res.json({success: false, type: 'danger', message : config});
  }
};

vlanController.removeVlanProfile = async function(req, res) {
  let config = await Config.findOne({is_default: true}).catch(function(rej) {
    return res.json({success: false, type: 'danger', message : rej.message});
  });
  if(config) {
    var is_to_delete, i, where_to_delete;
    
    if(typeof req.body.ids === "string") {
      req.body.ids = [req.body.ids]
    }

    for(i = 0; i < req.body.ids.length ; i++) {
      is_to_delete = false;
      where_to_delete = 0;
      for(j = 0; j < config.vlans_profiles.length ; j++) {
        if(config.vlans_profiles[j]._id.toString() === req.body.ids[i]) {
          is_to_delete = true;
          where_to_delete = j;
        }
      }
      if(is_to_delete) {
        config.vlans_profiles.splice(where_to_delete, 1);
      }
    }

    config.save().then(function() {
      return res.json({ success: true, type: 'success', message: 'Perfis de VLAN deletados com sucesso!'});
    }).catch(function(rej) {
      return res.json({success: false, type: 'danger', message : rej.message});
    });
  }
  else {
    res.json({success: false, type: 'danger', message : config});
  }
};

vlanController.getVlans = function(req, res) {
  DeviceModel.findById(req.params.deviceid, function(err, matchedDevice) {
    if (err || !matchedDevice) {
      console.log(err);
      return res.json({success: false, type: 'danger', message: 'Erro ao encontrar dispositivo'});
    }
    else {
      return res.json({success: true, type: 'success', vlan: matchedDevice.vlan.list_of_vlans});
    }
  });
};

vlanController.updateVlans = async function(req, res) {
  let device = await DeviceModel.findById(req.params.deviceid).catch(function(rej) {
    return res.json({success: false, type: 'danger', message : rej.message});
  });
  if(device) {
    
    // needs validation
    device.vlan = {};
    device.vlan.did_change_vlan = true;
    device.vlan.list_of_vlans = JSON.parse(req.body.vlans);

    device.save().then(function() {
      return res.json({ success: true, type: 'success', message: 'VLANs do dispositivo '+req.params.deviceid+' atualizada com sucesso!'});
    }).catch(function(rej) {
      return res.json({success: false, type: 'danger', message : rej.message});
    });
  }
  else {
    res.json({success: false, type: 'danger', message : "Dispositivo não encontrado."});
  }
};

vlanController.retrieveAndChangeStatus = async function(device) {
  var ret = "";
  if(device.vlan.did_change_vlan == true) {
    let deviceModel = await DeviceModel.findById(device._id).catch(function(rej) {
      console.log(rej.message);
    });
    deviceModel.vlan.did_change_vlan = false;
    ret = await deviceModel.save().then(() => {return "y";});
  }
  else {
    ret = "n";
  }
  console.log(ret);
  return ret;
};

vlanController.retrieveVlansToDevice = function(device) {
  /*
  vlan: {
    vlan_id: assoc_ports
  }
  i.g.  

  <<what is saved in device model>>
  [
    {"vlan_id":1,"port":1},
    {"vlan_id":100,"port":2},
    {"vlan_id":127,"port":3},
    {"vlan_id":51,"port":4}
  ]

  <<what is sent to device>>
  vlan : {
    "1" : "1 6t"
    "100" : "2 1t"
    "127" : "3 1t"
    "51" : "4 1t"
    "2" : "0 6t"
  }
  */
  var retObj = {};
  
  let lan_ports = DeviceVersion.getDevicePort(device.model, "lan_ports");
  let wan_port = DeviceVersion.getDevicePort(device.model, "wan_port");
  let cpu_port = DeviceVersion.getDevicePort(device.model, "cpu_port");

  // on well behavior object of vlan that needs to treat others vlans
  if(device.vlan.list_of_vlans !== undefined) {
    // initialize keys values with empty string
    for(let i = 0 ; i < device.vlan.list_of_vlans.length ; i++) {
      retObj[device.vlan.list_of_vlans[i].vlan_id] = "";
    }

    // put on every key an append to the value as the matching port
    for(let i = 0 ; i < device.vlan.list_of_vlans.length ; i++) {
      retObj[device.vlan.list_of_vlans[i].vlan_id] += lan_ports[device.vlan.list_of_vlans[i].port-1].toString()+" ";
    }
    // get a internet port to tag in others vlans
    let port_to_tag = retObj["1"].split('')[0];

    // put the tagged ports
    for(let key in retObj) {
      if(key === "1") {
        retObj[key] += cpu_port.toString()+"t";
      }
      else {
        retObj[key] += port_to_tag.toString()+"t";
      }
    }
  }
  // in the case of misconfiguration or none configuration of vlan at all, set the default configuration for vlan
  else {
    classic_vlan_config = "";
    for(let i = 0 ; i < lan_ports.length ; i++) {
      classic_vlan_config += lan_ports[i].toString()+" ";
    }
    classic_vlan_config += cpu_port.toString()+"t"
    retObj["1"] = classic_vlan_config;
  }
  
  retObj["2"] = wan_port.toString() + " " + cpu_port.toString() + "t";

  console.log(retObj);

  return retObj;
};

module.exports = vlanController;