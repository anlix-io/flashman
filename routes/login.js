
var express = require('express');
var router = express.Router();
var userController = require('../controllers/user');
var authController = require('../controllers/auth');

// Requests for creating and getting users
router.route('/')
    .get(function(req, res) {
        return res.render('login');
    })
    .post(authController.uiAuthenticate);

module.exports = router;
