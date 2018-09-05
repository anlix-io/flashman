let loadDeviceInfoOnForm = function(row) {
  let index = row.data('index');
  $('#edit_pppoe_user-' + index.toString()).val(row.data('user')).change();
  $('#edit_pppoe_pass-' + index.toString()).val(row.data('pass')).change();
  $('#edit_wifi_ssid-' + index.toString()).val(row.data('ssid')).change();
  $('#edit_wifi_pass-' + index.toString()).val(row.data('wifi-pass')).change();
  $('#edit_wifi_channel-' + index.toString()).val(row.data('channel')).change();
  $('#edit_ext_ref_type_selected-' + index.toString())
    .closest('.input-group-btn').find('#ext_ref_type a:contains("' +
      row.data('external-ref-type') + '")').click();
  $('#edit_external_reference-' + index.toString())
    .val(row.data('external-ref')).change();

  let connectionType = row.data('connection-type').toUpperCase();
  if (connectionType === 'DHCP') {
    $('#edit_connect_type-' + index.toString()).val('DHCP');
    $('#edit_pppoe_user-' + index.toString()).parent().hide();
    $('#edit_pppoe_pass-' + index.toString()).parent().hide();
  } else {
    $('#edit_connect_type-' + index.toString()).val('PPPoE');
    $('#edit_pppoe_user-' + index.toString()).parent().show();
    $('#edit_pppoe_pass-' + index.toString()).parent().show();
  }

  $('#edit_connect_type-' + index.toString()).change(function() {
    $('#edit_connect_type_warning-' + index.toString()).show();
    $('#edit_connect_type-' + index.toString()).addClass('orange lighten-4');
    if ($('#edit_connect_type-' + index.toString()).val() === 'PPPoE') {
      $('#edit_pppoe_user-' + index.toString()).parent().show();
      $('#edit_pppoe_pass-' + index.toString()).parent().show();
    } else {
      $('#edit_pppoe_user-' + index.toString()).parent().hide();
      $('#edit_pppoe_pass-' + index.toString()).parent().hide();
    }
  });

  // Device info
  $('#info_device_model-' + index.toString()).val(
    row.data('device-model').toUpperCase()
  );
  $('#info_device_version-' + index.toString()).val(
    row.data('device-version')
  );
};

let downloadCSV = function(csv, filename) {
  let csvFile;
  let downloadLink;
  // CSV file
  csvFile = new Blob([csv], {type: 'text/csv'});
  // Download link
  downloadLink = document.createElement('a');
  // File name
  downloadLink.download = filename;
  // Create a link to the file
  downloadLink.href = window.URL.createObjectURL(csvFile);
  // Hide download link
  downloadLink.style.display = 'none';
  // Add the link to DOM
  document.body.appendChild(downloadLink);
  // Click download link
  downloadLink.click();
};

let exportTableToCSV = function(filename) {
  let csv = [];
  let rows = document.querySelectorAll('table tr.csv-export');

  for (let i = 0; i < rows.length; i++) {
    let row = [];
    for (let data in rows[i].dataset) {
      if (data != 'index') {
        if (rows[i].dataset[data]) {
          row.push(rows[i].dataset[data]);
        } else {
          row.push('-');
        }
      }
    }
    csv.push(row.join(','));
  }
  // Download CSV file
  downloadCSV(csv.join('\n'), filename);
};

let refreshExtRefType = function(event) {
  let selectedSpan = $(event.target).closest('.input-group-btn').find('span.selected');
  let selectedItem = $(event.target).closest('#ext_ref_type').find('.active');
  let inputField = $(event.target).closest('.input-group').find('input');
  selectedSpan.text($(this).text());
  selectedItem.removeClass('active teal lighten-2');
  $(event.target).addClass('active teal lighten-2');

  if ($(this).text() == 'CPF') {
    inputField.mask('000.000.000-009').keyup();
  } else if ($(this).text() == 'CNPJ') {
    inputField.mask('00.000.000/0000-00').keyup();
  } else {
    inputField.unmask();
  }
};

$(document).ready(function() {
  // Enable tags on search input
  [].forEach.call(document.querySelectorAll('input[type="tags"]'), tagsInput);
  // The code below related to tags is because the tags-input plugin resets
  // all classes after loading
  $('.tags-input').addClass('form-control');
  $('.tags-input input').css('cssText', 'margin-top: 10px !important;');

  $('#card-header').click(function() {
    let plus = $(this).find('.fa-plus');
    let cross = $(this).find('.fa-times');
    plus.removeClass('fa-plus').addClass('fa-times');
    cross.removeClass('fa-times').addClass('fa-plus');
  });

  $('.fa-chevron-right').parents('td').click(function(event) {
    let row = $(event.target).parents('tr');
    let index = row.data('index');
    let formId = '#form-' + index.toString();
    if ($(this).children().hasClass('fa-chevron-right')) {
      loadDeviceInfoOnForm(row);
      $(formId).show();
      $(this).find('.fa-chevron-right')
        .removeClass('fa-chevron-right')
        .addClass('fa-chevron-down');
    } else if ($(this).children().hasClass('fa-chevron-down')) {
      $(formId).hide();
      $(this).find('.fa-chevron-down')
        .removeClass('fa-chevron-down')
        .addClass('fa-chevron-right');
    }
  });
  $('#ext_ref_type a').on('click', refreshExtRefType);
  $('.ext-ref-input').mask('000.000.000-009').keyup();

  $('#btn-elements-per-page').click(function(event) {
    $.ajax({
      type: 'POST',
      url: '/user/elementsperpage',
      traditional: true,
      data: {elementsperpage: $('#input-elements-pp').val()},
      success: function(res) {
        if (res.type == 'success') {
          window.location.reload();
        } else {
          displayAlertMsg(res);
        }
      },
    });
  });

  $('#export-csv').click(function(event) {
    exportTableToCSV('lista-de-roteadores-flashbox.csv');
  });
});
