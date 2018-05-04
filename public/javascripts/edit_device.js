let removeEditErrors = function(errors, index) {
  $('#editDeviceForm-' + index.toString()).find('p').remove();
  for (let key in errors) {
    $(errors[key].field).removeClass('red lighten-4');
  }
};

let renderEditErrors = function(errors) {
  for (let key in errors) {
    if (errors[key].messages.length > 0) {
      $(errors[key].field).addClass('red lighten-4');
      let message = '';
      errors[key].messages.forEach(function(msg) {
        message += msg + '<br />';
      });
      let element = '<p class="red-text"><small>' + message + '</small></p>';
      $(errors[key].field).parent().after(element);
    }
  }
};

let validateEditDevice = function(event) {
  $('.form-control').blur(); // Remove focus from form
  let validator = new Validator();

  let row = $(event.target).parents('tr');
  let index = row.data('index');

  // Get form values
  let mac = row.data('deviceid');
  let pppoe = $('#edit_connect_type-' + index.toString()).val() === 'PPPoE';
  let pppoe_user = $('#edit_pppoe_user-' + index.toString()).val();
  let pppoe_password = $('#edit_pppoe_pass-' + index.toString()).val();
  let ssid = $('#edit_wifi_ssid-' + index.toString()).val();
  let password = $('#edit_wifi_pass-' + index.toString()).val();
  let channel = $('#edit_wifi_channel-' + index.toString()).val();
  let external_reference = $('#edit_external_reference-' + index.toString()).val();

  // Initialize error structure
  let errors = {
    pppoe_user: {field: '#edit_pppoe_user-' + index.toString()},
    pppoe_password: {field: '#edit_pppoe_pass-' + index.toString()},
    ssid: {field: '#edit_wifi_ssid-' + index.toString()},
    password: {field: '#edit_wifi_pass-' + index.toString()},
    channel: {field: '#edit_wifi_channel-' + index.toString()},
  };
  for (let key in errors) {
    errors[key]['messages'] = [];
  }

  // Clean previous error values from DOM
  removeEditErrors(errors, index);

  let genericValidate = function(value, func, errors) {
    let valid_field = func(value);
    if (!valid_field.valid) {
      errors.messages = valid_field.err;
    }
  };

  // Validate fields
  if (pppoe) {
    genericValidate(pppoe_user, validator.validateUser, errors.pppoe_user);
    genericValidate(pppoe_password, validator.validatePassword, errors.pppoe_password);
  }
  genericValidate(ssid, validator.validateSSID, errors.ssid);
  genericValidate(password, validator.validateWifiPassword, errors.password);
  genericValidate(channel, validator.validateChannel, errors.channel);

  let hasNoErrors = function(key) {
    return errors[key].messages.length < 1;
  };

  if (Object.keys(errors).every(hasNoErrors)) {
    // If no errors present, send to backend
    let data = {'content': {
      'pppoe_user': (pppoe) ? pppoe_user : '',
      'pppoe_password': (pppoe) ? pppoe_password : '',
      'wifi_ssid': ssid,
      'wifi_password': password,
      'wifi_channel': channel,
      'external_reference': external_reference,
    }};

    $.ajax({
      type: 'POST',
      url: '/devicelist/update/' + mac,
      dataType: 'json',
      data: JSON.stringify(data),
      contentType: 'application/json',
      success: function(resp) {
        if ('errors' in resp) {
          let keyToError = {
            pppoe_user: errors.pppoe_user,
            pppoe_password: errors.pppoe_password,
            ssid: errors.ssid,
            password: errors.password,
            channel: errors.channel,
          };
          resp.errors.forEach(function(pair) {
            let key = Object.keys(pair)[0];
            keyToError[key].messages.push(pair[key]);
          });
          renderDeviceErrors(errors);
        } else {
          location.reload();
        }
      },
    });
  } else {
    // Else, render errors on form
    renderEditErrors(errors);
  }
  return false;
};

$(document).ready(function() {
  $('.edit-form').submit(validateEditDevice);
});
