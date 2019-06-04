
const express = require('express');

let router = express.Router();

router.use('/login', require('./login'));
router.use('/devicelist', require('./device_list'));
router.use('/deviceinfo', require('./device_info'));
router.use('/measure', require('./measure'));
router.use('/user', require('./user'));
router.use('/firmware', require('./firmware'));
router.use('/upgrade', require('./upgrade'));
router.use('/notification', require('./notification'));
router.use('/api', require('./api/api'));

router.get('/', function(req, res) {
  res.redirect('/devicelist');
});

router.get('/logout', function(req, res) {
  req.logout();
  res.redirect('/login');
});

module.exports = router;
