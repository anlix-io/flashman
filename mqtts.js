
const aedes = require('aedes');
const DeviceModel = require('./models/device');

let mqtts = aedes();

mqtts.on('client', function (client, err) {
  console.log('Router connected on MQTT: '+client.id);
});

mqtts.on('clientDisconnect', function (client, err) {
  console.log('Router disconnected on MQTT: '+client.id)
});

mqtts.authenticate = function(client, username, password, cb) {
  var needauth = true;
  if(process.env.FLM_TEMPORARY_MQTT_BROKER_PORT) {
    // Temporary disabled auth for old routers
    if(client.id) {
      if(client.id.startsWith("mosqsub")) {
        console.log('MQTT AUTH on INSECURE SERVER: Device '+client.id);
        cb(null, true);
        needauth = false;
      }
    }
  } 

  if(needauth) {
    if(!username) {
      console.log('MQTT AUTH ERROR - Username not specified: Device '+client.id);
      var error = new Error('Auth error');
      error.returnCode = 2;
      cb(error, null);
    } else {

      DeviceModel.findById(username, function(err, matchedDevice) {
        if (err) {
          console.log('MQTT AUTH ERROR: Device '+username+' not found: ' + err);
          var error = new Error('Auth error');
          error.returnCode = 2;
          cb(error, null);
        } else {
          if (matchedDevice == null) {
            console.log('MQTT AUTH ERROR: Device '+username+' internal error: ' + err);
            var error = new Error('Auth error');
            error.returnCode = 2;
            cb(error, null);
          } else {
            console.log("MQTT AUTH OK: id "+username);
            cb(null, password == matchedDevice.mqtt_secret)
          }
        }
      });
    }
  }
}

mqtts.anlix_message_router_update = function(id) {
	mqtts.publish({
      cmd: 'publish',
      qos: 1,
      retain: true,
      topic: 'flashman/update/' + id,
      payload: '1'
    });
	console.log('MQTT Message router update to '+id);
};

mqtts.anlix_message_router_reset = function(id) {
	mqtts.publish({
      cmd: 'publish',
      qos: 1,
      retain: true,
      topic: 'flashman/update/' + id,
      payload: ''
    });
	console.log('MQTT Message router reset to '+id);
};

module.exports = mqtts;