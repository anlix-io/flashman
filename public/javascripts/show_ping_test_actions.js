import {displayAlertMsg, socket} from './common_actions.js';
import 'selectize';

let isPingHostListInitialized = false;

const saveHostList = function() {
  if (isPingHostListInitialized) {
    let hostList = $('#hosts-list')[0].selectize.getValue();
    let id = $('#ping-test-hlabel').text();

    $.ajax({
      type: 'POST',
      url: '/devicelist/pinghostslist/' + id,
      dataType: 'json',
      data: JSON.stringify({
        'content': JSON.stringify({'hosts': hostList}),
      }),
      contentType: 'application/json',
      success: function(res) {
        if (res.success) {
          $('#hosts-list').removeClass('is-invalid').addClass('is-valid');
          setTimeout(function() {
            $('#hosts-list').removeClass('is-invalid is-valid');
          }, 1500);
        } else {
          $('#hosts-list-invalid-feedback').html(res.message);
          $('#hosts-list').removeClass('is-valid').addClass('is-invalid');
        }
      },
      error: function(xhr, status, error) {
        $('#hosts-list-invalid-feedback').html(error);
        $('#hosts-list').removeClass('is-valid').addClass('is-invalid');
      },
    });
  }
};

const selectizeOptionsHosts = {
  create: true,
  onItemAdd: saveHostList,
  onItemRemove: saveHostList,
  render: {
    option_create: function(data, escape) {
      return $('<div></div>').addClass('create').append(
        'Adicionar: ',
        $('<strong></strong>').html(escape(data.input))
      );
    },
  },
};

// Important: include and initialize socket.io first using socket var
socket.on('PINGTEST', function(macaddr, data) {
  if (($('#ping-test').data('bs.modal') || {})._isShown) {
    let id = $('#ping-test-hlabel').text();
    if (id == macaddr) {
      $('#ping-test-results').hide('fast').empty();
      $('.btn-start-ping-test').prop('disabled', false);
      let resultsList = $('<ul></ul>').addClass('list-group list-group-flush');

      $.each(data.results, function(key, value) {
        let hostname = key;
        let hostLatency = value.lat;
        let hostLoss = value.loss;

        resultsList.append(
          $('<li></li>').addClass('list-group-item d-flex')
          .addClass('justify-content-between align-items-center')
          .html(hostname)
          .append(
            $('<span></span>')
            .addClass('badge badge-primary badge-pill')
            .html('latência de ' + hostLatency + ' ms'),
            $('<span></span>')
            .addClass('badge badge-primary badge-pill')
            .html(hostLoss + '% pacotes perdidos')
          )
        );
      });
      $('#ping-test-results').append(resultsList).show('fast');
    }
  }
});

$(document).ready(function() {
  // Init selectize fields
  $('#hosts-list').selectize(selectizeOptionsHosts);

  $(document).on('click', '.btn-ping-test-modal', function(event) {
    let row = $(event.target).parents('tr');
    let id = row.data('deviceid');

    $.ajax({
      type: 'GET',
      url: '/devicelist/pinghostslist/' + id,
      dataType: 'json',
      success: function(res) {
        if (res.success) {
          let pingHosts = res.ping_hosts_list;
          // Fill hosts field with selected values
          $.each(pingHosts, function(idx, value) {
            $('#hosts-list')[0].selectize.addOption(
              {value: value, text: value});
            $('#hosts-list')[0].selectize.addItem(value);
          });
          $('#hosts-list')[0].selectize.refreshItems();
          $('#ping-test-hlabel').text(id);
          $('#ping-test').modal('show');

          isPingHostListInitialized = true;
        } else {
          displayAlertMsg(res);
        }
      },
      error: function(xhr, status, error) {
        displayAlertMsg(JSON.parse(xhr.responseText));
      },
    });
  });

  $(document).on('click', '.btn-start-ping-test', function(event) {
    let textarea = $('#ping-test-results');
    let id = $('#ping-test-hlabel').text();
    $('.btn-start-ping-test').prop('disabled', true);
    $.ajax({
      url: '/devicelist/command/' + id + '/ping',
      type: 'post',
      dataType: 'json',
      success: function(res) {
        $('#ping-test-placeholder').hide('fast', function() {
          $('#ping-test-results').empty().show('fast');
          if (res.success) {
            textarea.append(
              $('<h2></h2>').addClass('text-center grey-text mb-3').append(
                $('<i></i>').addClass('fas fa-spinner fa-pulse fa-4x'),
                $('</br>'),
                $('</br>'),
                $('<span></span>').html('Aguardando resposta do CPE...')
              )
            );
          } else {
            $('.btn-start-ping-test').prop('disabled', false);
            textarea.append(
              $('<h2></h2>').addClass('text-center grey-text mb-3').append(
                $('<i></i>').addClass('fas fa-times fa-4x'),
                $('</br>'),
                $('<span></span>').html(res.message)
              )
            );
          }
        });
      },
      error: function(xhr, status, error) {
        $('#ping-test-placeholder').hide('fast', function() {
          $('#ping-test-results').empty().show('fast');
          $('.btn-start-ping-test').prop('disabled', false);
          textarea.append($('<p></p>').text(status + ': ' + error));
        });
      },
    });
  });

  // Restore default modal state
  $('#ping-test').on('hidden.bs.modal', function() {
    $('#ping-test-results').hide().empty();
    $('#ping-test-placeholder').show();
    $('#hosts-list').removeClass('is-valid is-invalid');
    $('.btn-start-ping-test').prop('disabled', false);
    isPingHostListInitialized = false;
  });
});
