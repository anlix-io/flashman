
var deviceModel = require('../models/device');
var deviceListController = {};

const fs = require('fs');
const imageReleasesDir = require('../config/configs').imageReleasesDir;

var getReleases = function() {
  var releases = [];
  fs.readdirSync(imageReleasesDir).forEach(filename => {
    // File name pattern is VENDOR_MODEL_RELEASE.bin
    var fnameSubStrings = filename.split('_');
    var releaseSubStringRaw = fnameSubStrings[fnameSubStrings.length - 1];
    var releaseSubStringsRaw = releaseSubStringRaw.split('.');
    var releaseId = releaseSubStringsRaw[0];
    var releaseModel = fnameSubStrings[1];
    var release = {id: releaseId, model: releaseModel};
    releases.push(release);
  });
  return releases;
};

var getStatus = function(devices) {
  var statusAll = {};
  var yesterday = new Date();
  // 24 hours back from now
  yesterday.setDate(yesterday.getDate() - 1);
  devices.forEach(device => {
    var deviceColor = "offline-sign";
    if(device.last_contact.getTime() > yesterday.getTime()) {
      deviceColor = "online-sign";
    }
    statusAll[device._id] = deviceColor;
  });
  return statusAll;
};

// List all devices on a main page
deviceListController.index = function(req, res) {
  var indexContent = {apptitle: 'FlashMan'};
  deviceModel.find(function(err, devices) {
    if(err) {
      indexContent.message = err.message;
      return res.render('error', indexContent);
    }
    var releases = getReleases();
    var status = getStatus(devices);
    indexContent.devices = devices;
    indexContent.releases = releases;
    indexContent.status = status;
    return res.render('index', indexContent);
  });
};

deviceListController.changeUpdate = function(req, res) {
  deviceModel.findById(req.params.id, function(err, matchedDevice) {
    if(err) {
      var indexContent = {apptitle: 'FlashMan'};
      indexContent.message = err.message;
      return res.render('error', indexContent);
    }
    var oldstatus = matchedDevice.do_update;
    if(oldstatus == true) {
      matchedDevice.do_update = false;
    } else {
      matchedDevice.do_update = true;
    }
    matchedDevice.release = req.params.release;
    matchedDevice.save();
    return res.status(200).json({'success': true});
  });
};

deviceListController.changeAllUpdates = function(req, res) {
  var form = JSON.parse(req.body.content);
  deviceModel.find({'_id': {'$in': Object.keys(form.ids)}},
  function(err, matchedDevices) {
    if(err) {
      var indexContent = {apptitle: 'FlashMan'};
      indexContent.message = err.message;
      return res.render('error', indexContent);
    }
    for(var idx in matchedDevices) {
      matchedDevices[idx].release = form.ids[matchedDevices[idx]._id];
      matchedDevices[idx].do_update = form.do_update;
      matchedDevices[idx].save();
    }
    return res.status(200).json({'success': true});
  });
};

module.exports = deviceListController;
