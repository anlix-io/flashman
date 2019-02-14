
const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate');
let Schema = mongoose.Schema;

let deviceSchema = new Schema({
  _id: String,
  external_reference: {kind: String, data: String},
  model: String,
  version: {type: String, default: '0.0.0'},
  release: String,
  measure_config: {
    measure_psk: String,
  },
  connection_type: {type: String, enum: ['pppoe', 'dhcp']},
  pppoe_user: String,
  pppoe_password: String,
  wifi_ssid: String,
  wifi_password: String,
  wifi_channel: String,
  wifi_band: String,
  wifi_mode: String,
  wifi_is_5ghz_capable: {type: Boolean, default: false},
  wifi_ssid_5ghz: String,
  wifi_password_5ghz: String,
  wifi_channel_5ghz: String,
  wifi_band_5ghz: String,
  wifi_mode_5ghz: String,
  app_password: String,
  lan_devices: [{
    mac: String,
    dhcp_name: String,
    is_blocked: {type: Boolean, default: false},
    name: String,
    port: [Number],
    dmz: {type: Boolean, default: false},
  }],
  wan_ip: String,
  wan_negociated_speed: String,
  wan_negociated_duplex: String,
  ip: String,
  ntp_status: String,
  last_contact: Date,
  last_hardreset: Date,
  do_update: Boolean,
  do_update_parameters: Boolean,
  mqtt_secret: String,
  mqtt_secret_bypass: {type: Boolean, default: false},
  firstboot_log: Buffer,
  firstboot_date: Date,
  lastboot_log: Buffer,
  lastboot_date: Date,
  apps: [{id: String, secret: String}],
  // For port forward
  forward_index: String,
  // Store hosts to measure against
  ping_hosts: {
    type: [String],
    default: [
      'www.google.com',
      'www.youtube.com',
      'www.facebook.com',
      'www.instagram.com',
    ],
  },
});

deviceSchema.plugin(mongoosePaginate);

let Device = mongoose.model('Device', deviceSchema );

module.exports = Device;
