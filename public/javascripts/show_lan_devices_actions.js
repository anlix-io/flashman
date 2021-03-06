import {displayAlertMsg, socket} from './common_actions.js';

$(document).ready(function() {
  let lanDevicesGlobalTimer;

  const refreshLanDevices = function(deviceId, upnpSupport, isBridge) {
    $('#lan-devices').modal();
    $('#lan-devices').attr('data-validate-upnp', upnpSupport);
    $('.btn-sync-lan').prop('disabled', true);
    $.ajax({
      url: '/devicelist/command/' + deviceId + '/onlinedevs',
      type: 'post',
      dataType: 'json',
      success: function(res) {
        if (res.success) {
          $('#lan-devices').attr('data-cleanup', true);
          // If exists
          $('#lan-devices').data('cleanup', true);
          $('.btn-sync-lan > i').addClass('animated rotateOut infinite');
        } else {
          $('#lan-devices').removeAttr('data-lan-devices-list');
          $('#lan-devices').removeData('lan-devices-list');
          $('#lan-devices').removeAttr('data-lan-routers-list');
          $('#lan-devices').removeData('lan-routers-list');
          $('#lan-devices-body').empty(); // Clear old data
          $('#lan-routers-body').empty(); // Clear old data
          $('#lan-devices-placeholder').show();
          $('#lan-devices-placeholder-none').hide();
          fetchLanDevices(deviceId, upnpSupport, isBridge);
        }
      },
      error: function(xhr, status, error) {
        $('#lan-devices').removeAttr('data-lan-devices-list');
        $('#lan-devices').removeData('lan-devices-list');
        $('#lan-devices').removeAttr('data-lan-routers-list');
        $('#lan-devices').removeData('lan-routers-list');
        $('#lan-devices-body').empty(); // Clear old data
        $('#lan-routers-body').empty(); // Clear old data
        $('#lan-devices-placeholder').show();
        $('#lan-devices-placeholder-none').hide();
        fetchLanDevices(deviceId, upnpSupport, isBridge);
      },
    });
  };

  const setUpnp = function(deviceId, lanDeviceId, upnpPermission, btnStatus) {
    $('.btn-upnp').prop('disabled', true);

    if (upnpPermission == 'accept') {
      upnpPermission = 'reject';
    } else {
      upnpPermission = 'accept';
    }

    $.ajax({
      url: '/devicelist/command/' + deviceId + '/updateupnp',
      type: 'post',
      dataType: 'json',
      traditional: true,
      data: {lanid: lanDeviceId, permission: upnpPermission},
      success: function(res) {
        if (res.success) {
          btnStatus.removeClass('indigo-text red-text')
                   .addClass(upnpPermission == 'accept' ?
                             'indigo-text' : 'red-text')
                   .html(upnpPermission == 'accept' ?
                         'Liberado' : 'Bloqueado');
          btnStatus.parent().data('permission', upnpPermission);
          setTimeout(function() {
            $('.btn-upnp').prop('disabled', false);
          }, 1000);
        } else {
          $('.btn-upnp').prop('disabled', false);
        }
      },
      error: function(xhr, status, error) {
        $('.btn-upnp').prop('disabled', false);
      },
    });
  };

  const setLanDevBlock = function(deviceId, lanDeviceId, isBlocked, btnStatus) {
    $('.btn-lan-dev-block').prop('disabled', true);

    isBlocked = !isBlocked;

    $.ajax({
      url: '/devicelist/landevice/block',
      type: 'post',
      dataType: 'json',
      traditional: true,
      data: {id: deviceId, lanid: lanDeviceId, isblocked: isBlocked},
      success: function(res) {
        if (res.success) {
          btnStatus.removeClass('indigo-text red-text')
                   .addClass(isBlocked ? 'red-text' : 'indigo-text')
                   .html(isBlocked ? 'bloqueada' : 'liberada');
          btnStatus.parent().data('blocked', isBlocked);
          setTimeout(function() {
            $('.btn-lan-dev-block').prop('disabled', false);
          }, 3000);
        } else {
          $('.btn-lan-dev-block').prop('disabled', false);
        }
      },
      error: function(xhr, status, error) {
        $('.btn-lan-dev-block').prop('disabled', false);
      },
    });
  };

  const fetchLanDevices = function(deviceId, upnpSupport,
                                   isBridge, hasSlaves=false,
  ) {
    let totalRouters = parseInt($('#lan-devices').data('slaves-count')) + 1;
    let syncedRouters = parseInt($('#lan-devices').data('routers-synced'));

    $('#lan-devices-placeholder-counter').text(
      syncedRouters + ' de ' + totalRouters);

    $.ajax({
      type: 'GET',
      url: '/devicelist/landevices/' + deviceId,
      dataType: 'json',
      success: function(res) {
        if (res.success) {
          let lanDevices = $('#lan-devices').data('lan-devices-list');
          let lanRouters = $('#lan-devices').data('lan-routers-list');
          if (lanDevices) {
            for (let newDevice of res.lan_devices) {
              let matchedDev = lanDevices.find(function(device) {
                if (device.mac === newDevice.mac) {
                  let doReplace = false;
                  if (device.conn_type === undefined &&
                      newDevice.conn_type !== undefined
                  ) {
                    doReplace = true;
                  } else if (newDevice.conn_type == 1 && newDevice.wifi_signal) {
                    doReplace = true;
                  } else if (newDevice.conn_type == 0 && newDevice.conn_speed) {
                    doReplace = true;
                  }
                  if (doReplace) {
                    let idx = lanDevices.indexOf(device);
                    lanDevices.splice(idx, 1);
                    lanDevices.push(newDevice);
                  }
                  return true;
                } else {
                  return false;
                }
              });
              if (!matchedDev) {
                lanDevices.push(newDevice);
              }
            }
            $('#lan-devices').data('lan-devices-list', lanDevices);
          } else {
            lanDevices = res.lan_devices;
            $('#lan-devices').attr('data-lan-devices-list',
                                   JSON.stringify(lanDevices));
          }

          if (lanRouters) {
            lanRouters[deviceId] = res.mesh_routers;
            $('#lan-devices').data('lan-routers-list', lanRouters);
          } else {
            lanRouters = {};
            lanRouters[deviceId] = res.mesh_routers;
            $('#lan-devices').attr('data-lan-routers-list',
                                   JSON.stringify(lanRouters));
          }

          // Exhibit devices and routers if all routers have already answered
          if (syncedRouters >= totalRouters) {
            clearTimeout(lanDevicesGlobalTimer);
            renderDevices(lanDevices, lanRouters, upnpSupport,
                          isBridge, hasSlaves);
          } else {
            $('#lan-devices-placeholder-counter').text(
              syncedRouters + ' de ' + totalRouters);
            // Create a timeout if remaining routers stop responding
            lanDevicesGlobalTimer = setTimeout(function() {
              if (syncedRouters < totalRouters) {
                renderDevices(lanDevices, lanRouters, upnpSupport,
                            isBridge, hasSlaves);
              }
            }, 25000);
          }
        } else {
          displayAlertMsg(res);
        }
      },
      error: function(xhr, status, error) {
        displayAlertMsg(JSON.parse(xhr.responseText));
      },
    });
  };

  const renderDevices = function(lanDevices, lanRouters, upnpSupport,
                                 isBridge, hasSlaves=false,
  ) {
    let isSuperuser = false;
    let grantLanDevices = 0;
    let grantLanDevicesBlock = false;

    if ($('#devices-table-content').data('superuser')) {
      isSuperuser = $('#devices-table-content').data('superuser');
    }
    if ($('#devices-table-content').data('role')) {
      let role = $('#devices-table-content').data('role');
      grantLanDevices = role.grantLanDevices;
    }
    if ($('#devices-table-content').data('role')) {
      let role = $('#devices-table-content').data('role');
      grantLanDevicesBlock = role.grantLanDevicesBlock;
    }

    $('#lan-devices-placeholder').hide();
    let lanDevsRow = $('#lan-devices-body');
    let countAddedDevs = 0;
    let lanRoutersRow = $('#lan-routers-body');
    let countAddedRouters = 0;

    $.each(lanDevices, function(idx, device) {
      // Skip if offline for too long
      if (device.is_old) {
        return true;
      }
      lanDevsRow.append(
        $('<div>')
        .addClass('col-lg m-1 grey lighten-4').append(
          $('<div>').addClass('row pt-2').append(
            ((device.conn_type != undefined) ?
              $('<div>').addClass('col').append(
                (device.conn_type == 0) ?
                  $('<i>').addClass('fas fa-ethernet fa-lg') :
                  $('<i>').addClass('fas fa-wifi fa-lg'),
                (device.conn_type == 0) ?
                  $('<span>').html('&nbsp Cabo') :
                  $('<span>').html('&nbsp Wi-Fi')
              ) :
              $('<div>').addClass('col')
            ),
            $('<button>').addClass('btn btn-primary btn-sm my-0 col')
                         .addClass('btn-lan-dev-block')
                         .attr('data-mac', device.mac)
                         .attr('data-blocked', device.is_blocked)
                         .attr('type', 'button')
                         .prop('disabled',
                               isBridge || !(isSuperuser || grantLanDevicesBlock))
            .append(
              (device.is_blocked) ?
                $('<i>').addClass('fas fa-lock fa-lg') :
                $('<i>').addClass('fas fa-lock-open fa-lg'),
              $('<span>').html('&nbsp Internet &nbsp'),
              (device.is_blocked) ?
                $('<span>')
                  .addClass('dev-block-status-text red-text')
                  .html('bloqueada') :
                $('<span>')
                  .addClass('dev-block-status-text indigo-text')
                  .html('liberada')
            ),
          ),
          $('<div>').addClass('row pt-3').append(
            $('<div>').addClass('col-4').append(
              (device.is_online ?
                $('<i>').addClass('fas fa-circle green-text') :
                $('<i>').addClass('fas fa-circle red-text')),
              (device.is_online ?
                $('<span>').html('&nbsp Online') :
                $('<span>').html('&nbsp Offline'))
            ),
            (device.conn_speed && device.is_online ?
              $('<div>').addClass('col-8 text-right').append(
                $('<h6>').text('Velocidade Máx. ' +
                                    device.conn_speed + ' Mbps')
              ) : ''
            ),
          ),
          (hasSlaves ?
            $('<div>').addClass('row pt-2').append(
              $('<div>').addClass('col').append(
                $('<div>').addClass('badge primary-color').html('Conectado no CPE ' + device.gateway_mac),
              ),
          ) : ''),
          $('<div>').addClass('row pt-2').append(
            $('<div>').addClass('col').append(
              $('<button>').addClass('btn btn-primary btn-sm mx-0')
                           .attr('type', 'button')
                           .attr('data-toggle', 'collapse')
                           .attr('data-target', '#ipv4-collapse-' + idx)
                           .prop('disabled', !device.ip)
              .append(
                $('<i>').addClass('fas fa-search'),
                $('<span>').html('&nbsp IPv4')
              ),
              $('<button>').addClass('btn btn-primary btn-sm')
                           .attr('type', 'button')
                           .attr('data-toggle', 'collapse')
                           .attr('data-target', '#ipv6-collapse-' + idx)
                           .prop('disabled', device.ipv6.length == 0)
              .append(
                $('<i>').addClass('fas fa-search'),
                $('<span>').html('&nbsp IPv6')
              ),
              ((isSuperuser || grantLanDevices > 1) && upnpSupport ?
                $('<button>').addClass('btn btn-primary btn-sm ' +
                                       'ml-0 btn-upnp')
                             .attr('type', 'button')
                             .attr('data-mac', device.mac)
                             .attr('data-permission',
                                   device.upnp_permission)
                             .prop('disabled', false)
                .append(
                  $('<span>').html('UPnP &nbsp'),
                  $('<span>')
                    .addClass('upnp-status-text')
                    .addClass(device.upnp_permission == 'accept' ?
                              'indigo-text' : 'red-text')
                    .html(device.upnp_permission == 'accept' ?
                          'Liberado' : 'Bloqueado')
                ) :
                ''
              ),
              // IPv4 section
              $('<div>').addClass('collapse')
                        .attr('id', 'ipv4-collapse-' + idx)
              .append(
                $('<div>').addClass('mt-2').append(
                  $('<h6>').text(device.ip)
                )
              ),
              // IPv6 section
              $('<div>').addClass('collapse')
                        .attr('id', 'ipv6-collapse-' + idx)
              .append(
                $('<div>').addClass('mt-2').append(() => {
                  let opts = $('<div>');
                  device.ipv6.forEach((ipv6) => {
                    opts.append($('<h6>').text(ipv6));
                  });
                  return opts.html();
                })
              )
            )
          ),
          $('<div>').addClass('row pt-3 mb-2').append(
            $('<div>').addClass('col').append(
              $('<h6>').text(device.name),
              $('<h6>').text(device.dhcp_name),
              $('<h6>').text(device.mac)
            ),
            (device.conn_type == 1 && device.is_online) ?
            $('<div>').addClass('col').append(
              $('<h6>').text(((device.wifi_freq) ? device.wifi_freq : 'N/D') + ' GHz'),
              $('<h6>').text('Modo: ' + ((device.wifi_mode) ? device.wifi_mode : 'N/D')),
              $('<h6>').text('Sinal: ' + ((device.wifi_signal) ? device.wifi_signal : 'N/D') +' dBm'),
              $('<h6>').text('SNR: ' + ((device.wifi_snr) ? device.wifi_snr : 'N/D') + ' dB')
              .append(
                $('<span>').html('&nbsp'),
                ((device.wifi_snr >= 25) ?
                 $('<i>').addClass('fas fa-circle green-text') :
                 (device.wifi_snr >= 15) ?
                 $('<i>').addClass('fas fa-circle yellow-text') :
                 $('<i>').addClass('fas fa-circle red-text')
                )
              )
            ) :
            ''
          )
        )
      );
      countAddedDevs += 1;
      // Line break every 2 columns
      if (countAddedDevs % 2 == 0) {
        lanDevsRow.append($('<div></div>').addClass('w-100'));
      }
    });

    // Exhibit mesh routers if a mesh network exists
    // eslint-disable-next-line guard-for-in
    for (let routerMacKey in lanRouters) {
      // Do not show if empty
      if (!lanRouters[routerMacKey] || lanRouters[routerMacKey].length == 0) {
        continue;
      }
      // Skip if information is too old
      if (lanRouters[routerMacKey].is_old) {
        continue;
      }

      let lanRouterCard = $('<div>')
      .addClass('col-lg m-1 pb-2 grey lighten-4').append(
        $('<div>').addClass('row pt-2').append(
          $('<div>').addClass('col text-right').append(
            $('<div>').addClass('badge primary-color')
                      .html('Conexões de ' + routerMacKey),
          ),
        ),
      );
      $.each(lanRouters[routerMacKey], function(idx, router) {
        lanRouterCard.append(
          $('<div>').addClass('row m-0 mt-2').append(
            $('<div>').addClass('col p-0').append(
              $('<div>').addClass('badge primary-color-dark z-depth-0')
                        .html('Conexão com ' + router.mac),
            ),
          ),
          $('<div>').addClass('row pt-2 m-0 mt-1 grey lighten-3').append(
            $('<div>').addClass('col').append(
              $('<h6>').text('Tempo conectado: ' +
                ((router.iface == 1) ?
                  'N/D' :
                  secondsTimeSpanToHMS(router.conn_time))),
              $('<h6>').text('Bytes recebidos: ' +
                ((router.iface == 1) ?
                  'N/D' :
                  router.rx_bytes)),
              $('<h6>').text('Bytes enviados: ' +
                ((router.iface == 1) ?
                  'N/D' :
                  router.tx_bytes)),
              $('<h6>').text('Sinal: ' +
                ((router.iface == 1) ?
                  'N/D' :
                  (router.signal +' dBm'))),
            ),
            $('<div>').addClass('col').append(
              $('<h6>').text('Velocidade de recepção: ' + router.rx_bit + ' Mbps'),
              $('<h6>').text('Velocidade de envio: ' + router.tx_bit + ' Mbps'),
              $('<h6>').text('Latência: ' +
                (router.latency > 0 ? router.latency + ' ms' : 'N/D')),
              $('<div>').addClass('mt-2').append(
                (router.iface == 1) ?
                  $('<i>').addClass('fas fa-ethernet fa-lg') :
                  $('<i>').addClass('fas fa-wifi fa-lg'),
                (router.iface == 1) ?
                  $('<span>').html('&nbsp; Cabo') :
                  $('<span>').html('&nbsp; Wi-Fi ' +
                                   (router.iface == 2 ? '2.4' : '5.0') + 'GHz')
              ),
            ),
          ),
        );
      });
      lanRoutersRow.append(lanRouterCard);
      countAddedRouters += 1;
      // Line break every 2 columns
      if (countAddedRouters % 2 == 0) {
        lanRoutersRow.append($('<div>').addClass('w-100'));
      }
    }

    // Placeholder if empty
    if ( lanDevsRow.is(':empty') && lanRoutersRow.is(':empty') ) {
      $('#lan-devices-placeholder-none').show();
    }
  };

  $(document).on('click', '.btn-lan-devices-modal', function(event) {
    let slaves = [];
    let row = $(event.target).parents('tr');
    let id = row.data('deviceid');
    let serialid = row.data('serialid');
    let isTR069 = row.data('is-tr069') === true; // cast to bool
    let isBridge = row.data('bridge-enabled') === 'Sim';
    let slaveCount = parseInt(row.data('slave-count'));
    let totalRouters = slaveCount + 1;
    if (slaveCount > 0) {
      slaves = JSON.parse(row.data('slaves').replace(/\$/g, '"'));
    }
    let upnpSupport = row.data('validate-upnp');
    $('#lan-devices').attr('data-slaves', slaves);
    $('#lan-devices').attr('data-slaves-count', slaveCount);
    // Controls device exhibition after all data has arrived in mesh mode
    $('#lan-devices').attr('data-routers-synced', 0);

    $('#isBridgeDiv').html(row.data('bridge-enabled'));
    $('#lan-devices-placeholder-none').hide();
    // Progress info when syncing with multiple routers in mesh
    $('#lan-devices-placeholder-counter').text('0 de ' + totalRouters);
    // Only display if mesh mode is active with multiple routers
    if (slaveCount == 0) $('.btn-group-lan-opts').hide();
    // Trigger lan device view
    $('.btn-show-lan-devs').trigger('click');
    // Refresh devices status
    if (isTR069) {
      $('#lan-devices-visual').text(serialid);
    } else {
      $('#lan-devices-visual').text(id);
    }
    $('#lan-devices-hlabel').text(id);
    refreshLanDevices(id, upnpSupport, isBridge);
  });

  $(document).on('click', '.btn-sync-lan', function(event) {
    let id = $('#lan-devices-hlabel').text();
    let upnpSupport = $('#lan-devices').data('validate-upnp');
    let isBridge = $('#isBridgeDiv').html() === 'Sim';

    $('#lan-devices').data('routers-synced', 0);
    clearTimeout(lanDevicesGlobalTimer);
    refreshLanDevices(id, upnpSupport, isBridge);
  });

  $(document).on('click', '.btn-show-lan-routers', function(event) {
    $('#lan-devices-body').hide();
    $('#lan-routers-body').show();
    $('.btn-show-lan-devs').removeClass('active');
    $('.btn-show-lan-routers').addClass('active');
  });

  $(document).on('click', '.btn-show-lan-devs', function(event) {
    $('#lan-routers-body').hide();
    $('#lan-devices-body').show();
    $('.btn-show-lan-routers').removeClass('active');
    $('.btn-show-lan-devs').addClass('active');
  });

  $(document).on('click', '.btn-upnp', function(event) {
    let id = $('#lan-devices-hlabel').text();
    let currBtnStatus = $(this).children('.upnp-status-text');
    let devId = $(this).data('mac');
    let upnpPermission = $(this).data('permission');
    setUpnp(id, devId, upnpPermission, currBtnStatus);
  });

  $(document).on('click', '.btn-lan-dev-block', function(event) {
    let id = $('#lan-devices-hlabel').text();
    let currBtnStatus = $(this).children('.dev-block-status-text');
    let devId = $(this).data('mac');
    let isDevBlocked = $(this).data('blocked');
    setLanDevBlock(id, devId, isDevBlocked, currBtnStatus);
  });

  // Important: include and initialize socket.io first using socket var
  socket.on('ONLINEDEVS', function(macaddr, data) {
    if (($('#lan-devices').data('bs.modal') || {})._isShown) {
      if ($('#lan-devices').data('cleanup') == true) {
        // Clear old data
        $('#lan-devices').data('cleanup', false);
        $('.btn-sync-lan').prop('disabled', false);
        $('.btn-sync-lan > i').removeClass('animated rotateOut infinite');
        $('#lan-devices').removeAttr('data-lan-devices-list');
        $('#lan-devices').removeData('lan-devices-list');
        $('#lan-devices').removeAttr('data-lan-routers-list');
        $('#lan-devices').removeData('lan-routers-list');
        $('#lan-devices-body').empty();
        $('#lan-routers-body').empty();
        $('#lan-devices-placeholder').show();
        $('#lan-devices-placeholder-none').hide();
      } else {
        $('#lan-devices-body').empty();
        $('#lan-routers-body').empty();
      }
      let id = $('#lan-devices-hlabel').text();
      let upnpSupport = $('#lan-devices').data('validate-upnp');
      let slaves = $('#lan-devices').data('slaves');
      let hasSlaves = slaves ? true : false;
      let isBridge = $('#isBridgeDiv').html() === 'Sim';
      if (id == macaddr || slaves.includes(macaddr)) {
        let totalSynced = $('#lan-devices').data('routers-synced');
        $('#lan-devices').data('routers-synced', totalSynced + 1);
        clearTimeout(lanDevicesGlobalTimer);
        fetchLanDevices(macaddr, upnpSupport, isBridge, hasSlaves);
      }
    }
  });

  // Restore default modal state
  $('#lan-devices').on('hidden.bs.modal', function() {
    $('#lan-devices').removeAttr('data-lan-devices-list');
    $('#lan-devices').removeData('lan-devices-list');
    $('#lan-devices').removeAttr('data-lan-routers-list');
    $('#lan-devices').removeData('lan-routers-list');
    $('#lan-devices').removeData('slaves');
    $('#lan-devices').removeData('slaves-count');
    $('#lan-devices').removeData('routers-synced');
    $('#lan-devices-body').empty();
    $('#lan-routers-body').empty();
    $('#lan-devices-placeholder').show();
    $('#lan-devices-placeholder-none').hide();
    $('.btn-sync-lan > i').removeClass('animated rotateOut infinite');
    $('.btn-sync-lan').prop('disabled', false);
    $('.btn-group-lan-opts').show();
    $('.btn-show-lan-routers').removeClass('active');
    $('.btn-show-lan-devs').addClass('active');
    clearTimeout(lanDevicesGlobalTimer);
  });
});
