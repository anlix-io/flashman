
const express = require('express');
const deviceListController = require('../controllers/device_list');
const authController = require('../controllers/auth');

let router = express.Router();

// GET home page
router.route('/').get(authController.ensureLogin(),
                      deviceListController.index);

// POST or API PUT change device update status
router.route('/update/:id/:release').post(
  authController.ensureLogin(),
  authController.ensurePermission('grantFirmwareUpgrade'),
  deviceListController.changeUpdate)
                                    .put(
  authController.ensureAPIAccess,
  authController.ensurePermission('grantAPIAccess'),
  deviceListController.changeUpdate);

// POST change all device status
router.route('/updateall').post(
  authController.ensureLogin(),
  authController.ensurePermission('grantFirmwareUpgrade'),
  deviceListController.changeAllUpdates);

// POST search device
router.route('/search').get(authController.ensureLogin(),
                            deviceListController.searchDeviceReg);

// REST API or POST delete device
router.route('/delete/:id').post(
  authController.ensureLogin(),
  authController.ensurePermission('grantDeviceRemoval'),
  deviceListController.delDeviceReg)
                           .delete(
  authController.ensureAPIAccess,
  authController.ensurePermission('grantAPIAccess'),
  deviceListController.delDeviceReg);

// REST API - GET device registry
router.route('/update/:id')
  .get(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.getDeviceReg);
// REST API - POST or PUT change device registry
router.route('/update/:id')
  .post(authController.ensureLogin(),
        deviceListController.setDeviceReg)
  .post(authController.ensureAPIAccess,
        authController.ensurePermission('grantAPIAccess'),
        deviceListController.setDeviceReg)
  .put(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.setDeviceReg);

// REST API - PUT create device registry
router.route('/create').post(
  authController.ensureLogin(),
  authController.ensurePermission('grantDeviceAdd'),
  deviceListController.createDeviceReg)
                       .put(
  authController.ensureAPIAccess,
  authController.ensurePermission('grantAPIAccess'),
  deviceListController.createDeviceReg);

// REST API - GET first boot logs
router.route('/firstlog/:id')
  .get(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.getFirstBootLog);
// from user interface
router.route('/uifirstlog/:id')
  .get(authController.ensureLogin(),
       authController.ensurePermission('grantLOGAccess'),
       deviceListController.getFirstBootLog);
// REST API - GET last boot logs
router.route('/lastlog/:id')
  .get(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.getLastBootLog);
// from user interface
router.route('/uilastlog/:id')
  .get(authController.ensureLogin(),
       authController.ensurePermission('grantLOGAccess'),
       deviceListController.getLastBootLog);

// REST API - Send a message using MQTT
router.route('/command/:id/:msg')
  .post(authController.ensureLogin(),
        authController.ensurePermission('grantDeviceActions'),
        deviceListController.sendMqttMsg)
  .put(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.sendMqttMsg);

// For user Interface - Set/Get Port forward
router.route('/uiportforward/:id')
  .get(authController.ensureLogin(),
       deviceListController.getPortForward)
  .post(authController.ensureLogin(),
        deviceListController.setPortForward);

// REST API - Set/Get Port forward
router.route('/portforward/:id')
  .get(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.getPortForward)
  .post(authController.ensureAPIAccess,
        authController.ensurePermission('grantAPIAccess'),
        deviceListController.setPortForward)
  .put(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.setPortForward);

// REST API - Set/Get Ping hosts list
router.route('/pinghostslist/:id')
  .get(authController.ensureLogin(),
       deviceListController.getPingHostsList)
  .post(authController.ensureLogin(),
        deviceListController.setPingHostsList)
  .post(authController.ensureAPIAccess,
        authController.ensurePermission('grantAPIAccess'),
        deviceListController.setPingHostsList)
  .put(authController.ensureAPIAccess,
       authController.ensurePermission('grantAPIAccess'),
       deviceListController.setPingHostsList);

router.route('/landevices/:id')
  .get(authController.ensureLogin(),
       deviceListController.getLanDevices);

module.exports = router;
