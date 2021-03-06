let User = require('../models/user');
let Config = require('../models/config');
let Firmware = require('../models/firmware');
const Role = require('../models/role');
const controlApi = require('./external-api/control');

const fs = require('fs');
const unzipper = require('unzipper');
const request = require('request');
const md5File = require('md5-file');
const path = require('path');
const imageReleasesDir = process.env.FLM_IMG_RELEASE_DIR;

let firmwareController = {};

let isValidFilename = function(filename) {
  return /^([A-Z\-0-9]+)_([A-Z\-0-9]+)_([A-Z0-9]+)_([0-9]{4}\-[a-z]{3})\.(bin)$/.test(filename);
};

let parseFilename = function(filename) {
  // File name pattern is VENDOR_MODEL_MODELVERSION_RELEASE.bin
  let fnameSubStrings = filename.split('_');
  let releaseSubStringRaw = fnameSubStrings[fnameSubStrings.length - 1];
  let releaseSubStringsRaw = releaseSubStringRaw.split('.');
  let firmwareRelease = releaseSubStringsRaw[0];

  let firmwareFields = {release: firmwareRelease,
                        vendor: fnameSubStrings[0],
                        model: fnameSubStrings[1],
                        version: fnameSubStrings[2]};
  return firmwareFields;
};

let removeFirmware = function(firmware) {
  return new Promise((resolve, reject)=> {
    fs.unlink(imageReleasesDir + firmware.filename, function(err) {
      if (err) {
        return reject('Arquivo não encontrado');
      }

      let md5fname = '.' + firmware.filename.replace('.bin', '.md5');
      fs.unlink(path.join(imageReleasesDir, md5fname), function(err) {
        firmware.remove(function(error) {
          if (error) {
            return reject('Registro não encontrado');
          }
          return resolve();
        });
      });
    });
  });
};

firmwareController.index = function(req, res) {
  let indexContent = {};
  indexContent.username = req.user.name;

  // Check Flashman automatic update availability
  if (typeof process.env.FLM_DISABLE_AUTO_UPDATE !== 'undefined' && (
             process.env.FLM_DISABLE_AUTO_UPDATE === 'true' ||
             process.env.FLM_DISABLE_AUTO_UPDATE === true)
  ) {
    indexContent.disableAutoUpdate = true;
  } else {
    indexContent.disableAutoUpdate = false;
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
      }
      Role.findOne({name: req.user.role}, function(err, role) {
        if (err) {
          console.log(err);
          indexContent.type = 'danger';
          indexContent.message = err.message;
          return res.render('error', indexContent);
        }
        indexContent.role = role;
        return res.render('firmware', indexContent);
      });
    });
  });
};

firmwareController.fetchFirmwares = function(req, res) {
  Firmware.find({}, function(err, firmwares) {
    if (err) {
      console.log(err);
      return res.json({success: false, type: 'danger',
                       message: 'Erro ao buscar firmwares'});
    }
    return res.json({success: true, type: 'success', firmwares: firmwares});
  });
};

firmwareController.getReleases = async function(filenames, role,
                                                isSuperuser,
                                                modelAsArray=false) {
  let firmwares = null;
  let releases = [];
  let releaseIds = [];
  let hasBetaGrant = false;
  let hasRestrictedGrant = false;
  if (isSuperuser) {
    hasBetaGrant = true;
    hasRestrictedGrant = true;
  } else if (role) {
    hasBetaGrant = role.grantFirmwareBetaUpgrade;
    hasRestrictedGrant = role.grantFirmwareRestrictedUpgrade;
  }
  try {
    if (hasBetaGrant && hasRestrictedGrant) {
      firmwares = await Firmware.find({'filename': {$in: filenames}});
    } else if (hasBetaGrant && !hasRestrictedGrant) {
      firmwares = await Firmware.find({'filename': {$in: filenames},
                                       'is_restricted': {$ne: true}});
    } else if (!hasBetaGrant && hasRestrictedGrant) {
      firmwares = await Firmware.find({'filename': {$in: filenames},
                                       'is_beta': {$ne: true}});
    } else {
      firmwares = await Firmware.find({'filename': {$in: filenames},
                                       'is_restricted': {$ne: true},
                                       'is_beta': {$ne: true}});
    }
  } catch (err) {
    console.error(err);
    return releases;
  }
  firmwares.forEach(function(firmware) {
    let releaseId = firmware.release;
    let releaseModel = firmware.model.concat(firmware.version);
    if (modelAsArray) {
      if (releaseIds.includes(releaseId)) {
        for (let i = 0; i < releases.length; i++) {
          if (releases[i].id == releaseId) {
            releases[i].model.push(releaseModel);
            break;
          }
        }
      } else {
        releases.push({id: releaseId,
                       model: [releaseModel],
                       is_beta: firmware.is_beta,
                       is_restricted: firmware.is_restricted});
        releaseIds.push(releaseId);
      }
    } else {
      releases.push({id: releaseId,
                     model: releaseModel,
                     is_beta: firmware.is_beta,
                     is_restricted: firmware.is_restricted});
    }
  });
  return releases;
};

firmwareController.delFirmware = function(req, res) {
  Firmware.find({'_id': {$in: req.body.ids}}, function(err, firmwares) {
    if (err || firmwares.length == 0) {
      return res.json({
        type: 'danger',
        message: 'Registro não encontrado ou selecionado',
      });
    }
    let promises = [];
    firmwares.forEach((firmware) => {
      promises.push(removeFirmware(firmware));
    });
    Promise.all(promises).then(
      function() {
        return res.json({
          type: 'success',
          message: 'Firmware(s) deletado(s) com sucesso!',
        });
      }, function(errMessage) {
        return res.json({
          type: 'danger',
          message: errMessage,
        });
    });
  });
};

firmwareController.uploadFirmware = function(req, res) {
  if (!req.files) {
    return res.json({type: 'danger',
                     message: 'Nenhum arquivo foi selecionado'});
  }

  let firmwarefile = req.files.firmwarefile;

  if (!isValidFilename(firmwarefile.name)) {
    return res.json({type: 'danger',
                     message: 'Formato inválido de arquivo. Nomes de arquivo ' +
                     'válidos: *FABRICANTE*_*MODELO*_*VERSÃO*_*RELEASE*.bin'});
  }

  firmwarefile.mv(imageReleasesDir + firmwarefile.name,
    function(err) {
      if (err) {
        return res.json({type: 'danger', message: 'Erro ao mover arquivo'});
      }

      // Generate MD5 checksum
      const md5Checksum = md5File.sync(path.join(imageReleasesDir,
                                                 firmwarefile.name));
      const md5fname = '.' + firmwarefile.name.replace('.bin', '.md5');
      fs.writeFile(path.join(imageReleasesDir, md5fname), md5Checksum,
        function(err) {
          if (err) {
            fs.unlink(path.join(imageReleasesDir, firmwarefile.name),
              function(err) {
                return res.json({
                  type: 'danger',
                  message: 'Erro ao gerar hash de integridade do arquivo',
                });
              },
            );
          }

          let fnameFields = parseFilename(firmwarefile.name);

          Firmware.findOne({
            vendor: fnameFields.vendor,
            model: fnameFields.model,
            version: fnameFields.version,
            release: fnameFields.release,
            filename: firmwarefile.name,
          }, function(err, firmware) {
            if (err) {
              // Remove downloaded files
              fs.unlink(path.join(imageReleasesDir, firmwarefile.name),
                function(err) {
                  fs.unlink(path.join(imageReleasesDir, md5fname),
                    function(err) {
                      return res.json({
                        type: 'danger',
                        message: 'Erro buscar na base de dados',
                      });
                    },
                  );
                },
              );
            }
            if (!firmware) {
              firmware = new Firmware({
                vendor: fnameFields.vendor,
                model: fnameFields.model,
                version: fnameFields.version,
                release: fnameFields.release,
                filename: firmwarefile.name,
              });
            } else {
              firmware.vendor = fnameFields.vendor;
              firmware.model = fnameFields.model;
              firmware.version = fnameFields.version;
              firmware.release = fnameFields.release;
              firmware.filename = firmwarefile.name;
            }

            firmware.save(function(err) {
              if (err) {
                let msg = '';
                for (let field = 0; field < err.errors.length; field++) {
                  msg += err.errors[field].message + ' ';
                }
                // Remove downloaded files
                fs.unlink(path.join(imageReleasesDir, firmwarefile.name),
                  function(err) {
                    fs.unlink(path.join(imageReleasesDir, md5fname),
                      function(err) {
                        return res.json({type: 'danger', message: msg});
                      },
                    );
                  },
                );
              }
              return res.json({
                type: 'success',
                message: 'Upload de firmware feito com sucesso!',
              });
            });
          });
        },
      );
    },
  );
};

firmwareController.syncRemoteFirmwareFiles = async function(req, res) {
  let retObj = await controlApi.authUser(req.body.name, req.body.password);
  if (retObj.success) {
    const resBody = retObj.res;
    const company = resBody.o;
    const firmwareBuilds = resBody.firmware_builds;
    request({
      url: 'https://artifactory.anlix.io/' +
           'artifactory/api/storage/upgrades/' + company,
      method: 'GET',
      auth: {
        user: req.body.name,
        pass: req.body.password,
      },
    },
    function(error, response, body) {
      if (error) {
        return res.json({type: 'danger', message: 'Erro na requisição'});
      }
      if (response.statusCode === 200) {
        let firmwareNames = [];
        let firmwareList = JSON.parse(body)['children'];
        for (let firmwareEntry of firmwareList) {
          let fileName = firmwareEntry.uri;
          let fileNameParts = fileName.split('_');
          if (fileNameParts.length < 4) {
            // Invalid entry
            continue;
          }
          let vendor = fileNameParts[0].split('/')[1];
          let model = fileNameParts[1];
          let version = fileNameParts[2];
          let release = fileNameParts[3].split('.')[0];
          const matchedFirmwareInfo = firmwareBuilds.find(
            (firmwareInfo) => {
              return (firmwareInfo.model.toUpperCase() === model &&
                      firmwareInfo.version.toUpperCase() === version &&
                      firmwareInfo.release === release);
          });
          let firmwareInfoObj = {
            company: company,
            vendor: vendor,
            model: model,
            version: version,
            release: release,
            uri: fileName,
          };
          if (matchedFirmwareInfo) {
            // Fields may not exist on very old firmwares
            if (matchedFirmwareInfo.flashbox_version) {
              firmwareInfoObj.flashbox_version =
                matchedFirmwareInfo.flashbox_version;
            }
            if (matchedFirmwareInfo.wan_proto) {
              firmwareInfoObj.wan_proto =
               matchedFirmwareInfo.wan_proto.toUpperCase();
            }
            if (matchedFirmwareInfo.is_beta != undefined) {
              firmwareInfoObj.is_beta = matchedFirmwareInfo.is_beta;
            }
            if (matchedFirmwareInfo.is_restricted != undefined) {
              firmwareInfoObj.is_restricted = matchedFirmwareInfo.is_restricted;
            }
          }
          firmwareNames.push(firmwareInfoObj);
        }
        let encodedAuth = Buffer.from(
          req.body.name + ':' + req.body.password).toString('base64');

        return res.json({type: 'success',
          firmwarelist: firmwareNames,
          encoded: encodedAuth,
        });
      } else {
        return res.json({
          type: 'danger',
          message: 'Erro na autenticação',
        });
      }
    });
  } else {
    return res.json({type: 'danger', message: 'Erro na autenticação'});
  }
};

let addFirmwareFile = function(fw) {
  return new Promise((resolve, reject)=> {
    let wanproto = '';
    let flashboxver = '';
    let isbeta = false;
    let isrestricted = false;
    if ('wanproto' in fw) {
      wanproto = fw.wanproto;
    }
    if ('flashboxversion' in fw) {
      flashboxver = fw.flashboxversion;
    }
    if ('isbeta' in fw) {
      isbeta = fw.isbeta;
    }
    if ('isrestricted' in fw) {
      isrestricted = fw.isrestricted;
    }
    let responseStream = request
      .get('https://artifactory.anlix.io/artifactory/upgrades/' +
        fw.company + fw.firmwarefile, {
          headers: {
            'Authorization': 'Basic ' + fw.encoded,
          },
        })
      .on('error', function(err) {
        return reject('Erro na requisição');
      })
      .on('response', function(response) {
        let unzipDest = new unzipper.Extract({path: imageReleasesDir});
        if (response.statusCode === 200) {
          responseStream.pipe(unzipDest);
          unzipDest.on('close', function() {
            let firmwarefname = fw.firmwarefile
              .replace('/', '')
              .replace('.zip', '.bin');
            let fnameFields = parseFilename(firmwarefname);

            // Generate MD5 checksum
            const md5Checksum = md5File.sync(path.join(imageReleasesDir,
                                                     firmwarefname));
            const md5fname = '.' + firmwarefname.replace('.bin', '.md5');
            fs.writeFile(path.join(imageReleasesDir, md5fname), md5Checksum,
              function(err) {
                if (err) {
                  fs.unlink(path.join(imageReleasesDir, firmwarefname),
                    function(err) {
                      return reject(
                        'Erro ao gerar hash de integridade do arquivo');
                    },
                  );
                }
                // Hash generated and saved. Register entry on db
                Firmware.findOne({
                  vendor: fnameFields.vendor,
                  model: fnameFields.model,
                  version: fnameFields.version,
                  release: fnameFields.release,
                  filename: firmwarefname,
                }, function(err, firmware) {
                  if (err) {
                    // Remove downloaded files
                    fs.unlink(path.join(imageReleasesDir, firmwarefname),
                      function(err) {
                        fs.unlink(path.join(imageReleasesDir, md5fname),
                          function(err) {
                            return reject('Erro buscar na base de dados');
                          },
                        );
                      },
                    );
                  }
                  if (!firmware) {
                    firmware = new Firmware({
                      vendor: fnameFields.vendor,
                      model: fnameFields.model,
                      version: fnameFields.version,
                      release: fnameFields.release,
                      wan_proto: wanproto,
                      flashbox_version: flashboxver,
                      filename: firmwarefname,
                      is_beta: isbeta,
                      is_restricted: isrestricted,
                    });
                  } else {
                    firmware.vendor = fnameFields.vendor;
                    firmware.model = fnameFields.model;
                    firmware.version = fnameFields.version;
                    firmware.release = fnameFields.release;
                    firmware.filename = firmwarefname;
                    firmware.wan_proto = wanproto;
                    firmware.flashbox_version = flashboxver;
                    firmware.is_beta = isbeta;
                    firmware.is_restricted = isrestricted;
                  }

                  firmware.save(function(err) {
                    if (err) {
                      let msg = '';
                      for (let field = 0; field < err.errors.length; field++) {
                        msg += err.errors[field].message + ' ';
                      }
                      // Remove downloaded files
                      fs.unlink(path.join(imageReleasesDir, firmwarefname),
                        function(err) {
                          fs.unlink(path.join(imageReleasesDir, md5fname),
                            function(err) {
                              return reject(msg);
                            },
                          );
                        },
                      );
                    }
                    return resolve();
                  });
                });
              },
            );
          });
        } else {
          return reject('Erro na autenticação');
        }
      });
  });
};

firmwareController.addRemoteFirmwareFile = function(req, res) {
  let firmwares = JSON.parse(req.body.firmwares);
  let promises = [];
  firmwares.forEach((firmware) => {
    promises.push(addFirmwareFile(firmware));
  });
  Promise.all(promises).then(
    function() {
      return res.json({
        type: 'success',
        message: 'Firmware(s) adicionado(s) com sucesso!',
      });
    }, function(errMessage) {
      return res.json({
        type: 'danger',
        message: errMessage,
      });
  });
};

module.exports = firmwareController;
