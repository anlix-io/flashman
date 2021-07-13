import 'jquery-mask-plugin';
import {tagsInput} from 'tags-input';
import {updateSearchResultsScheduler} from './show_upgrade_schedule_actions.js';
import {fillTotalDevicesFromSearch} from './show_data_collecting_actions.js';
import {displayAlertMsg,
        secondsTimeSpanToHMS,
        socket} from './common_actions.js';

let downloadCSV = function(url, filename) {
  let downloadLink = document.createElement('a');
  downloadLink.download = filename;
  downloadLink.href = url;
  downloadLink.style.display = 'none';
  document.body.appendChild(downloadLink);
  downloadLink.click();
};

let refreshExtRefType = function(event) {
  let selectedSpan = $(event.target).closest('.input-group-btn')
                                    .find('span.selected');
  let selectedItem = $(event.target).closest('.ext-ref-type').find('.active');
  let inputField = $(event.target).closest('.input-group').find('input');
  selectedSpan.text($(this).text());
  selectedItem.removeClass('active primary-color');
  $(event.target).addClass('active primary-color');

  if ($(this).text() == 'CPF') {
    inputField.mask('000.000.000-009').keyup();
  } else if ($(this).text() == 'CNPJ') {
    inputField.mask('00.000.000/0000-00').keyup();
  } else {
    inputField.unmask();
  }
};

let refreshLicenseStatus = function(event) {
  let row = $(event.target).parents('tr');
  let deviceId = row.data('deviceid');
  // If undefined it is a mesh slave entry
  if (deviceId == undefined) {
    deviceId = row.prev().data('deviceid');
  }
  let inputField = $(event.target).closest('.input-group').find('input');
  let thisBtn = $(this);
  thisBtn.attr('disabled', true);
  $.ajax({
    type: 'POST',
    url: '/devicelist/license',
    traditional: true,
    data: {id: deviceId},
    success: function(res) {
      thisBtn.attr('disabled', false);
      if (res.status === undefined) {
        inputField.val('Desconhecido');
      } else if (res.status === true) {
        inputField.val('Ativa');
      } else {
        inputField.val('Bloqueada');
      }
    },
  });
};

let changeDeviceStatusOnTable = function(table, macaddr, data) {
  let deviceOnTable = table.find('#' + $.escapeSelector(macaddr));
  let statusOnlineSum = table.find('#online-status-sum');
  let statusRecoverSum = table.find('#recovery-status-sum');
  let statusOffSum = table.find('#offline-status-sum');
  if (deviceOnTable.length) {
    if (data == 'online' || data == 'recovery') {
      let status = deviceOnTable.find('.device-status');
      let currentGreen = status.hasClass('green-text');
      let currentRed = status.hasClass('red-text');
      let currentOnlineCount = parseInt(statusOnlineSum.text());
      let currentRecoveryCount = parseInt(statusRecoverSum.text());
      let currentOfflineCount = parseInt(statusOffSum.text());
      let canIncreaseCounter = false;
      if (currentGreen && (currentOnlineCount > 0)) {
        statusOnlineSum.text(currentOnlineCount - 1);
        canIncreaseCounter = true;
      } else if (currentRed && (currentRecoveryCount > 0)) {
        statusRecoverSum.text(currentRecoveryCount - 1);
        canIncreaseCounter = true;
      } else if (currentOfflineCount > 0) {
        statusOffSum.text(currentOfflineCount - 1);
        canIncreaseCounter = true;
      }
      if (data == 'online' && canIncreaseCounter) {
        statusOnlineSum.text(
          parseInt(statusOnlineSum.text()) + 1);
        let newStatus = 'green-text';
        status.removeClass('green-text red-text grey-text').addClass(newStatus);
      } else if (data == 'recovery' && canIncreaseCounter) {
        statusRecoverSum.text(
          parseInt(statusRecoverSum.text()) + 1);
        let newStatus = 'red-text';
        status.removeClass('green-text red-text grey-text').addClass(newStatus);
      }
    } else {
      let alert = deviceOnTable.find('.device-alert');
      let alertLink = alert.parent();
      alertLink.removeClass('d-none');
      alertLink.off('click').click(function(event) {
        let options = {
          type: 'warning',
          confirmButtonText: data.action_title,
          confirmButtonColor: '#4db6ac',
          cancelButtonText: 'Cancelar',
          cancelButtonColor: '#f2ab63',
          showCancelButton: true,
        };
        if (data.type === 'genieacs') {
          options.title = data.message;
          let error = data.message_error;
          if (error) error = error.replace(/\n/g, '<br>');
          options.html = error;
        } else {
          options.text = data.message;
        }
        swal(options).then(function(result) {
          if (result.value) {
            let deleteNotification = function() {
              $.ajax({type: 'POST', url: '/notification/del',
                traditional: true, data: {id: data._id}})
              .done(() => {
                alertLink.addClass('d-none');
                fetchNotificationsForDevice(data.target);
              });
            };
            if (data.action_url && data.action_url != '/notification/del') {
              $.ajax({type: 'POST', url: data.action_url, traditional: true})
              .done(deleteNotification);
            } else {
              deleteNotification();
            }
          } else if (result.dismiss !== undefined && !data.seen) {
            $.ajax({type: 'POST', url: '/notification/seen',
              traditional: true, data: {id: data._id}})
            .done(() => {
              data.seen = true;
            });
          }
        });
      });
    }
  }
};

/* fetch notifications for a single device and sets triangle with exclamation
 mark. */
let fetchNotificationsForDevice = function(deviceId) {
  $.ajax({type: 'POST', url: '/notification/fetch', traditional: true,
    data: {targets: [deviceId]}})
  .done((response) => {
    let deviceTableContent = $('#devices-table-content');
    for (let notification of response.notifications) {
      changeDeviceStatusOnTable(deviceTableContent, deviceId, notification);
    }
  });
};

$(document).ready(function() {
  // Enable tags on search input
  [].forEach.call(document.querySelectorAll('input[type="tags"]'), tagsInput);
  // The code below related to tags is because the tags-input plugin resets
  // all classes after loading
  $('.tags-input').addClass('form-control').css('padding', '0');
  $('.tags-input input').css('cssText', 'margin-top: 10px !important;');

  let role = $('#devices-table-content').data('role');
  let visibleColumnsOnPage = $('#devices-table-content').
    data('visiblecolumnsonpage');
  let isSuperuser = false;
  let enableDataCollecting = false;
  let grantFirmwareUpgrade = false;
  let grantMassFirmwareUpgrade = false;
  let grantNotificationPopups = false;
  let grantWifiInfo = false;
  let grantPPPoEInfo = false;
  let grantDeviceActions = false;
  let grantLOGAccess = false;
  let grantLanEditAccess = false;
  let grantLanDevsAccess = false;
  let grantSiteSurveyAccess = false;
  let grantSpeedMeasure = false;
  let grantDeviceRemoval = false;
  let grantDeviceMassRemoval = false;
  let grantFactoryReset = false;
  let grantDeviceId = false;
  let grantPassShow = false;
  let grantOpmodeEdit = false;
  let grantVlan = 0;
  let grantWanBytes = false;
  let grantShowSearchSummary = false;
  let grantWanType = false;

  // For actions applied to multiple routers
  let selectedDevices = [];

  if ($('#devices-table-content').data('superuser')) {
    isSuperuser = $('#devices-table-content').data('superuser');
  }
  if ($('#devices-table-content').data('enabledatacollecting')) {
    enableDataCollecting = $('#devices-table-content').data('enabledatacollecting');
  }
  if ($('#devices-table-content').data('role')) {
    grantFirmwareUpgrade = role.grantFirmwareUpgrade;
    grantMassFirmwareUpgrade = role.grantMassFirmwareUpgrade;
    grantNotificationPopups = role.grantNotificationPopups;
    grantWifiInfo = role.grantWifiInfo;
    grantPPPoEInfo = role.grantPPPoEInfo;
    grantDeviceActions = role.grantDeviceActions;
    grantLOGAccess = role.grantLOGAccess;
    grantLanEditAccess = role.grantLanEdit;
    grantLanDevsAccess = role.grantLanDevices;
    grantSiteSurveyAccess = role.grantSiteSurvey;
    grantDeviceRemoval = role.grantDeviceRemoval;
    grantDeviceMassRemoval = role.grantDeviceMassRemoval;
    grantFactoryReset = role.grantFactoryReset;
    grantDeviceId = role.grantDeviceId;
    grantPassShow = role.grantPassShow;
    grantSpeedMeasure = role.grantMeasureDevices;
    grantOpmodeEdit = role.grantOpmodeEdit;
    grantVlan = role.grantVlan;
    grantWanBytes = role.grantWanBytesView;
    grantShowSearchSummary = role.grantShowSearchSummary;
    grantWanType = role.grantWanType;
  }

  // Default column to sort rows
  let columnToSort = '/sort-mac-addr';
  let columnSortType = '/sort-type-asc';
  $('#sort-mac-addr').append('\u2191').css('font-weight', 'Bold');

  $(document).on('click', '#card-header', function(event) {
    let plus = $(this).find('.fa-plus');
    let cross = $(this).find('.fa-times');
    plus.removeClass('fa-plus').addClass('fa-times');
    cross.removeClass('fa-times').addClass('fa-plus');
  });

  $(document).on('click', '.fa-chevron-down.device-table-row', function(event) {
    let slave = $(event.target).hasClass('slave-row');
    if (slave) {
      let target = $(event.target).parents('tr').next();
      target.removeClass('d-none');
    } else {
      let row = $(event.target).parents('tr');
      let index = row.data('index');
      let formId = '#form-' + index.toString();
      $(formId).removeClass('d-none');
      $('.slave-'+index).removeClass('d-none');
    }
    $(event.target).removeClass('fa-chevron-down')
                   .addClass('fa-chevron-up text-primary');
    // Stop event from reaching tr element
    event.stopPropagation();
  });

  $(document).on('click', '.fa-chevron-up.device-table-row', function(event) {
    let slave = $(event.target).hasClass('slave-row');
    if (slave) {
      let target = $(event.target).parents('tr').next();
      target.addClass('d-none');
    } else {
      let row = $(event.target).parents('tr');
      let index = row.data('index');
      let formId = '#form-' + index.toString();
      $(formId).addClass('d-none');
      $('.slave-'+index).addClass('d-none');
      let slaveCount = row.data('slave-count');
      for (let i = 0; i < slaveCount; i++) {
        row = row.next().next();
        row.find('.fa-chevron-up').trigger('click');
      }
    }
    $(event.target).removeClass('fa-chevron-up text-primary')
                   .addClass('fa-chevron-down');
    // Stop event from reaching tr element
    event.stopPropagation();
  });

  $(document).on('click', '.selectable-device-row', function(event) {
    let row = $(event.target).parents('tr');
    let deviceId = row.data('deviceid');
    if (row.hasClass('device-row-selected')) {
      row.removeClass('device-row-selected');
      row.css('background-color', '');
      // Remove device from action list
      let deviceIdx = selectedDevices.indexOf(deviceId);
      if (deviceIdx != -1) {
        selectedDevices.splice(deviceIdx, 1);
        if (selectedDevices.length == 0) {
          $('#btn-trash-multiple').addClass('disabled');
        }
      }
    } else {
      row.addClass('device-row-selected');
      row.css('background-color', 'gainsboro');
      // Add device to action list
      selectedDevices.push(deviceId.toUpperCase());
      $('#btn-trash-multiple').removeClass('disabled');
    }
  });

  $(document).on('click', '.ext-ref-type a', refreshExtRefType);

  $(document).on('click', '.btn-license-status-refresh', refreshLicenseStatus);

  $(document).on('click', '#btn-elements-per-page', function(event) {
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

  $(document).on('click', '#btn-save-columns-on-page', function(event) {
    let selColumns = [];
    let elements = $('.dropdown-menu.dont-close a :checked');
    elements.each(function(index) {
      let columnId = $(this).attr('id');
      let columnNumber = columnId.split('-')[2];
      selColumns.push(columnNumber);
    });
    $.ajax({
      type: 'POST',
      url: '/user/visiblecolumnsperpage',
      traditional: true,
      data: {visiblecolumnsperpage: selColumns},
      success: function(res) {
        $('#save-columns-confirm').fadeTo('fast', 1, function() {
          $(this).fadeTo('slow', 0);
        });
      },
    });
  });

  $(document).on('click', '#export-csv', function(event) {
    let filterList = $('#devices-search-input').val();
    let exportURL = '/devicelist/export?filter=' +
                    encodeURIComponent(filterList);
    downloadCSV(exportURL, 'lista-de-cpes-flashbox.csv');
  });

  $(document).on('click', '.tab-switch-btn', function(event) {
    let tabId = $(this).data('tab-id');
    $(tabId).siblings().addClass('d-none');
    $(tabId).removeClass('d-none');
  });

  $(document).on('click', '#btn-upgrade-scheduler', function(event) {
    $('#upgrade-scheduler').modal('show');
  });

  // Refresh table content
  $(document).on('click', '#refresh-table-content', function(event) {
    let pageNum = parseInt($('#curr-page-link').html());
    let filterList = $('#devices-search-input').val();
    filterList += ',' + columnToSort + ',' + columnSortType;
    loadDevicesTable(pageNum, filterList);
  });

  const updateSlavesRecursively = function(row, iter, update,
                                           status, remain, mac='') {
    if (iter < 0) {
      if (!update) {
        // Activate dropdown
        row.find('.device-update .dropdown-toggle .selected').text('Escolher');
        row.find('.device-update .dropdown-toggle').attr('disabled', false);
        // Deactivate waiting status
        let upgradeStatus = row.find('span.upgrade-status');
        upgradeStatus.find('.status-none').removeClass('d-none');
        upgradeStatus.find('.status-waiting').addClass('d-none');
        upgradeStatus.find('.status-ok').addClass('d-none');
        upgradeStatus.find('.status-error').addClass('d-none');
        // Deactivate cancel button
        row.find('.btn-group .btn-cancel-update').attr('disabled', true);
      } else {
        // Deactivate dropdown
        row.find('.device-update .dropdown-toggle').attr('disabled', true);
        // Update waiting status
        let upgradeStatus = row.find('span.upgrade-status');
        upgradeStatus.find('.status-none').addClass('d-none');
        upgradeStatus.find('.status-waiting').addClass('d-none');
        upgradeStatus.find('.status-ok').addClass('d-none');
        upgradeStatus.find('.status-error').addClass('d-none');
        if (status == 0 || status == 10) {
          upgradeStatus.find('.status-waiting').removeClass('d-none');
          let slaveCount = row.data('slave-count');
          let tooltip = 'Atualizando CPE...';
          if (remain === slaveCount+1) {
            tooltip = 'Atualizando CPE principal...';
          } else if (remain > 0) {
            let current = slaveCount - remain + 1;
            tooltip = 'Atualizando CPE secundário '+
              current+' de '+slaveCount+'...';
          }
          upgradeStatus.find('.status-waiting').attr('title', tooltip);
        } else if (status == 1) {
          upgradeStatus.find('.status-ok').removeClass('d-none');
        } else if (status >= 2) {
          let slaveCount = row.data('slave-count');
          let progress = (remain === slaveCount+1) ? 0
            : slaveCount - remain + 1;
          let errorAnchor = upgradeStatus.find('.status-error');
          errorAnchor.attr('data-progress', progress);
          errorAnchor.attr('data-mac', mac);
          errorAnchor.removeClass('d-none');
        }
        // Activate cancel button
        row.find('.btn-group .btn-cancel-update').attr('disabled', false);
      }
      return;
    }
    let slaveRow = row;
    for (let i = 0; i <= iter; i++) {
      slaveRow = slaveRow.next().next();
    }
    let localDeviceId = slaveRow.data('deviceid');
    $.ajax({
      url: '/devicelist/uiupdate/' + localDeviceId,
      type: 'GET',
      success: function(res) {
        slaveRow.find('.device-status').
          removeClass('green-text red-text grey-text').
          addClass(res.status_color + '-text');
        slaveRow.find('.device-wan-ip').html(res.wan_ip);
        slaveRow.find('.device-ip').html(res.ip);
        slaveRow.find('.device-installed-release').html(res.installed_release);
        let localUpdate = update;
        let localStatus = status;
        let localMac = mac;
        if (!localUpdate) {
          localUpdate = res.do_update;
          localStatus = res.do_update_status;
          localMac = res._id;
        }
        updateSlavesRecursively(row, iter-1, localUpdate,
          localStatus, remain, localMac);
      },
    });
  };

  // Refresh single row
  $(document).on('click', '.device-row-refresher', function(event) {
    let row = $(event.target).parents('tr');
    let deviceId = row.data('deviceid');
    let isTR069 = row.data('isTr069');
    let upstatusCmd = 'upstatus';
    if (isTR069) {
      upstatusCmd += 'tr069';
    }
    let thisBtn = $(this);
    let sysUptime = row.find('.device-sys-up-time');
    let wanUptime = row.find('.device-wan-up-time');
    // Stop event from reaching tr element
    event.stopPropagation();
    // Block button until response has been received
    thisBtn.prop('disabled', true).css('color', 'grey');
    thisBtn.find('.icon-row-refresh').addClass('fa-spinner fa-pulse');
    // Dispatch update for wan and sys uptime only if not pending
    if (!sysUptime.hasClass('pending-update') &&
        !wanUptime.hasClass('pending-update')) {
      $.ajax({
        url: '/devicelist/command/' + deviceId + '/' + upstatusCmd,
        type: 'post',
        dataType: 'json',
        success: function(res) {
          sysUptime.addClass('grey-text pending-update');
          wanUptime.addClass('grey-text pending-update');
        },
      });
    }

    // fetch notifications and set triangle with exclamation mark.
    fetchNotificationsForDevice(deviceId);

    $.ajax({
      url: '/devicelist/uiupdate/' + deviceId,
      type: 'GET',
      success: function(res) {
        row.find('.device-status').removeClass('green-text red-text grey-text')
                                  .addClass(res.status_color + '-text');
        let wanip = res.wan_ip;
        row.find('.device-wan-ip').html(wanip);
        row.find('.device-ip').html(res.ip);
        row.find('.device-installed-release').html(res.installed_release);
        row.find('.device-pppoe-user').html(res.pppoe_user);
        let slaveCount = row.data('slave-count');
        let resSlaveCount = (res.mesh_slaves) ? res.mesh_slaves.length : 0;
        if (slaveCount !== resSlaveCount) return;
        updateSlavesRecursively(
          row,
          slaveCount-1,
          res.do_update,
          res.do_update_status,
          res.do_update_mesh_remaining,
          deviceId,
        );
      },
      complete: function(xhr, status) {
        thisBtn.prop('disabled', false).css('color', 'black');
        thisBtn.find('.icon-row-refresh').removeClass('fa-spinner fa-pulse');
      },
    });
  });

  let changeDevicesColumnVisibility = function(changeTo, colNum) {
    let statusHCol = $('table#devices-table th:nth-child(' + colNum +')');
    let statusDCol = $('table#devices-table td:nth-child(' + colNum +')');
    if (changeTo === 'invisible') {
      statusHCol.hide();
      statusDCol.hide();
    } else if (changeTo === 'visible') {
      statusHCol.show();
      statusDCol.show();
    }
  };

  let applyVisibleColumns = function() {
    let allHideableCols = [];
    let elements = $('[id^=devices-column-]');
    elements.each(function(index) {
      let columnId = $(this).attr('id');
      let columnNumber = columnId.split('-')[2];
      $('#devices-column-' + columnNumber).prop('checked', true);
      changeDevicesColumnVisibility('visible', columnNumber);
      allHideableCols.push(columnNumber);
    });
    allHideableCols.forEach(function(index) {
      if (!visibleColumnsOnPage.includes(parseInt(index))) {
        $('#devices-column-' + index).prop('checked', false);
        changeDevicesColumnVisibility('invisible', index);
      }
    });
  };

  const buildRowData = function(device, index) {
    let rowAttr = 'id="' + device._id + '"';
    rowAttr += ' data-index="' + index + '"';
    rowAttr += ' data-is-tr069="'+device.use_tr069+'"';
    rowAttr += ' data-slave-count="' +
               (device.mesh_slaves ? device.mesh_slaves.length : 0) + '"';
    rowAttr += ' data-deviceid="' + device._id + '"';
    rowAttr += ' data-serialid="' + device.serial_tr069 + '"';
    return rowAttr;
  };

  const buildStatusClasses = function(device) {
    return 'fas fa-circle fa-lg device-status '+device.status_color;
  };

  const buildStatusAttributes = function(device) {
    return 'data-toggle="tooltip" title="'+device.last_contact.toString()+'"';
  };

  const buildNotification = function() {
    return '<a class="d-none">'+
      '<div class="fas fa-exclamation-triangle fa-lg orange-text '+
                  'device-alert animated heartBeat infinite">'+
      '</div>'+'<span>&nbsp;</span><span>&nbsp;</span>'+
    '</a>';
  };

  const buildPonSignalColumn = function(device, grantPonSignalSupport = false) {
    let ponSignalStatus;
    let ponSignalRxPower = `<span>${device.pon_rxpower}</span>`;
    if (device.pon_rxpower === undefined) { 
      ponSignalStatus = '<div class="badge badge-dark">Sem Sinal</div>';
      ponSignalRxPower = '';
    } else if (device.pon_rxpower >= 3){
      ponSignalStatus = '<div class="badge red">Erro Sinal Alto</div>';
    } else if (device.pon_rxpower >= -18) {
      ponSignalStatus = '<div class="badge green">Sinal Bom</div>';
    } else if (device.pon_rxpower <= -23) {
      ponSignalStatus = '<div class="badge yellow">Sinal Baixo</div>';
    let ponSignalStatusColumn = (isTR069) ? `
      <td>
        <div class="text-center align-items-center">
          ${ponSignalRxPower}
          ${ponSignalStatus} 
        </div>
      </td>
    ` : '<td></td>';
    return ponSignalStatusColumn;
  }

  const buildUpgradeCol = function(device, slaves=[], isTR069=false) {
    let upgradeOpts = '';
    for (let idx = 0; idx < device.releases.length; idx++) {
      let release = device.releases[idx];
      // Skip stock firmwares from being listed
      if (release.id === '9999-aix') {
        continue;
      }
      let slaveHasRelease = true;
      slaves.forEach((slave)=>{
        if (!slaveHasRelease) return;
        if (!slave.releases.find((r)=>r.id===release.id)) {
          // slaveHasRelease = false;
        }
      });
      if (!slaveHasRelease) continue;
      upgradeOpts += '<a class="dropdown-item text-center">'+release.id+'</a>';
    }
    let upgradeCol = (isTR069) ? '<td></td>':
    '<td>'+
      '<div class="btn-group device-update">'+
        '<button class="btn btn-sm px-2'+
        ' btn-cancel-update btn-danger" $NO_UPDATE>'+
          '<div class="fas fa-times"></div>'+
        '</button>'+
        '<div class="btn-group">'+
          '<button class="btn btn-sm btn-primary dropdown-toggle"'+
          ' type="button" data-toggle="dropdown" $NO_UPDATE_DROP>'+
            '<span class="selected">$UP_RELEASE</span>'+
          '</button>'+
          '<div class="dropdown-menu refresh-selected">'+upgradeOpts+'</div>'+
        '</div>'+
        '<span class="ml-3 upgrade-status">'+
          '<div class="fas fa-circle fa-2x white-text status-none $STATUS_NO"></div>'+
          '<div class="fas fa-spinner fa-2x fa-pulse status-waiting $STATUS_0" data-toggle="tooltip", title="$TOOLTIP"></div>'+
          '<div class="fas fa-check-circle fa-2x green-text status-ok $STATUS_1"></div>'+
          '<a class="status-error $STATUS_2" $MESH_PARAMS>'+
            '<div class="fas fa-exclamation-circle fa-2x red-text"></div>'+
          '</a>'+
        '</span>'+
      '</div>'+
    '</td>';
    let inProgress = device.do_update;
    let status = device.do_update_status;
    let meshCount = device.do_update_mesh_remaining;
    let slaveCount = slaves.length;
    let currentSlave = device._id;
    let currentSlaveNum = 0;
    let tooltipMsg = 'Atualizando CPE...';
    if (slaveCount > 0) {
      slaves.forEach((slave)=>{
        if (inProgress) return;
        inProgress = slave.do_update;
        status = slave.do_update_status;
        currentSlave = slave._id;
      });
      if (meshCount === slaveCount+1) {
        tooltipMsg = 'Atualizando CPE principal...';
      } else {
        currentSlaveNum = slaveCount - meshCount + 1;
        tooltipMsg = 'Atualizando CPE secundário '+currentSlaveNum+' de '+slaveCount+'...';
      }
    }
    if (inProgress) {
      upgradeCol = upgradeCol.replace('$UP_RELEASE', device.release);
      upgradeCol = upgradeCol.replace('$NO_UPDATE', '');
      upgradeCol = upgradeCol.replace('$NO_UPDATE_DROP', 'disabled');
      upgradeCol = upgradeCol.replace('$STATUS_NO', 'd-none');
      if (status == 0 || status == 10) {
        upgradeCol = upgradeCol.replace('$STATUS_0', '');
        upgradeCol = upgradeCol.replace('$STATUS_1', 'd-none');
        upgradeCol = upgradeCol.replace('$STATUS_2', 'd-none');
        upgradeCol = upgradeCol.replace('$TOOLTIP', tooltipMsg);
        upgradeCol = upgradeCol.replace('$MESH_PARAMS', '');
      } else if (status == 1) {
        upgradeCol = upgradeCol.replace('$STATUS_0', 'd-none');
        upgradeCol = upgradeCol.replace('$STATUS_1', '');
        upgradeCol = upgradeCol.replace('$STATUS_2', 'd-none');
        upgradeCol = upgradeCol.replace('$TOOLTIP', '');
        upgradeCol = upgradeCol.replace('$MESH_PARAMS', '');
      } else if (status >= 2) {
        upgradeCol = upgradeCol.replace('$STATUS_0', 'd-none');
        upgradeCol = upgradeCol.replace('$STATUS_1', 'd-none');
        upgradeCol = upgradeCol.replace('$STATUS_2', '');
        upgradeCol = upgradeCol.replace('$TOOLTIP', '');
        if (slaveCount > 0) {
          let meshParams = 'data-progress="'+currentSlaveNum+'" data-mac="'+currentSlave+'"';
          upgradeCol = upgradeCol.replace('$MESH_PARAMS', meshParams);
        } else {
          upgradeCol = upgradeCol.replace('$MESH_PARAMS', '');
        }
      }
    } else {
      upgradeCol = upgradeCol.replace('$UP_RELEASE', 'Escolher');
      upgradeCol = upgradeCol.replace('$NO_UPDATE', 'disabled');
      upgradeCol = upgradeCol.replace('$NO_UPDATE_DROP', '');
      upgradeCol = upgradeCol.replace('$STATUS_NO', '');
      upgradeCol = upgradeCol.replace('$STATUS_0', 'd-none');
      upgradeCol = upgradeCol.replace('$STATUS_1', 'd-none');
      upgradeCol = upgradeCol.replace('$STATUS_2', 'd-none');
      upgradeCol = upgradeCol.replace('$TOOLTIP', '');
      upgradeCol = upgradeCol.replace('$MESH_PARAMS', '');
    }
    return upgradeCol;
  };

  const buildTableRowInfo = function(device, selectable,
                                     meshSlave=false, index=0, isTR069=false) {
    let rowClass = (meshSlave) ? 'd-none grey lighten-3 slave-'+index : '';
    let chevClass = (meshSlave) ? 'slave-row' : '';
    let selectableClass = (selectable) ? 'selectable-device-row' : 'not-selectable-device-row';
    let refreshIcon = (meshSlave) ? '' :
    '<a class="device-row-refresher">'+
      '<div class="icon-row-refresh fas fa-sync-alt fa-lg hover-effect"></div>'+
    '</a>';
    let infoRow = '<tr class=" ' + selectableClass + ' ' + rowClass + '" $REPLACE_ATTRIBUTES>'+
      '<td class="pl-1 pr-0">'+
        refreshIcon+
      '</td><td class="text-center">'+
        '<div class="fas fa-chevron-down fa-lg device-table-row hover-effect '+chevClass+'"></div>'+
      '</td><td>'+
        '<div class="$REPLACE_COLOR_CLASS" $REPLACE_COLOR_ATTR>'+
        '<span>&nbsp;</span><span>&nbsp;</span>'+
        '$REPLACE_NOTIFICATIONS'+
        '</div><div class="badge teal $REPLACE_COLOR_CLASS_PILL">$REPLACE_PILL_TEXT</div>'+
      '</td><td class="text-center device-pppoe-user">'+
        device.pppoe_user+
      '</td><td class="text-center">'+
        ((device.use_tr069) ? device.serial_tr069 : device._id)+
      '</td><td class="text-center device-wan-ip">'+
        device.wan_ip+
      '</td><td class="text-center device-ip">'+
        device.ip+
      '</td><td class="text-center device-installed-release">'+
        device.installed_release+
      '</td><td class="text-center">'+
        (device.external_reference ? device.external_reference.data : '')+
      '</td><td class="text-center device-sys-up-time">'+
        (device.sys_up_time && device.status_color !== 'grey-text' ?
          secondsTimeSpanToHMS(parseInt(device.sys_up_time)) : '') +
      '</td><td class="text-center device-wan-up-time">'+
        (device.wan_up_time && device.status_color !== 'grey-text' ?
          secondsTimeSpanToHMS(parseInt(device.wan_up_time)) : '')+
      '</td>'+
      '$REPLACE_PONSIGNAL'+
      '$REPLACE_UPGRADE'+
    '</tr>';
    return infoRow;
  };

  const buildRemoveDevice = function(small=false) {
    let smallClass = (small) ? 'btn-sm' : '';
    return '<button class="btn btn-danger '+smallClass+' btn-trash m-0" type="button">'+
      '<i class="fas fa-trash"></i><span>&nbsp Remover</span>'+
    '</button>';
  };

  const buildFormSubmit = function(mesh=false) {
    let meshClass = (mesh) ? 'edit-form-mesh' : '';
    return '<div class="row">'+
      '<div class="col text-right">'+
        '<button class="btn btn-primary mx-0 '+meshClass+'" type="submit">'+
          '<i class="fas fa-check fa-lg"></i><span>&nbsp Editar</span>'+
        '</button>'+
      '</div>'+
    '</div>';
  };

  const buildAboutTab = function(device, index, isTR069,
                                 hasExtendedChannels, mesh=-1) {
    let idIndex = ((mesh > -1) ? index + '_' + mesh : index); // Keep _ !
    let createdDateStr = '';
    let resetDateStr = '';
    if (isNaN(Date.parse(device.created_at))) {
      createdDateStr = 'Não disponível';
    } else {
      let createdDate = new Date(device.created_at);
      createdDateStr = createdDate.toLocaleDateString(navigator.language,
        {hour: '2-digit', minute: '2-digit'});
    }
    if (isNaN(Date.parse(device.last_hardreset))) {
      resetDateStr = 'Não disponível';
    } else {
      let resetDate = new Date(device.last_hardreset);
      resetDateStr = resetDate.toLocaleDateString(navigator.language,
        {hour: '2-digit', minute: '2-digit'});
    }
    let lastReset = '<div class="md-form input-entry pt-1">'+
      '<label class="active">Último reset no CPE realizado em</label>'+
      '<input class="form-control" type="text" '+
      'disabled value="'+resetDateStr+'">'+
      '<div class="invalid-feedback"></div>'+
    '</div>';
    let aboutTab = '<div class="row">'+
      '<div class="col-6">'+
        '<div class="md-form input-entry pt-1">'+
          '<label class="active">Registro do CPE criado em</label>'+
          '<input class="form-control" type="text" '+
          'disabled value="'+createdDateStr+'">'+
          '<div class="invalid-feedback"></div>'+
        '</div>'+
        '<div class="md-form input-group input-entry">'+
          '<div class="input-group-btn">'+
            '<button class="btn btn-primary dropdown-toggle ml-0 my-0" '+
            'type="button" data-toggle="dropdown" $REPLACE_EN_ID>'+
              '<span class="selected" id="edit_ext_ref_type_selected-'+idIndex+'">'+
                (device.external_reference ? device.external_reference.kind : 'CPF')+
              '</span>'+
            '</button>'+
            '<div class="dropdown-menu ext-ref-type">'+
              '<a class="dropdown-item text-center $REPLACE_ID_CPF">CPF</a>'+
              '<a class="dropdown-item text-center $REPLACE_ID_CNPJ">CNPJ</a>'+
              '<a class="dropdown-item text-center $REPLACE_ID_OTHER">Outro</a>'+
            '</div>'+
          '</div>'+
          '<input class="form-control py-0 added-margin" type="text" '+
          'id="edit_external_reference-'+idIndex+'" placeholder="ID do cliente (opcional)" '+
          'maxlength="64" value="$REPLACE_ID_VAL" $REPLACE_EN_ID>'+
          '</input>'+
          '<div class="invalid-feedback"></div>'+
        '</div>'+
        (!isTR069 ?
        '<div class="md-form input-group input-entry">'+
          '<label class="active">Status da licença é</label>' +
          '<input class="form-control py-0 added-margin" type="text" '+
          'id="edit_license_status-'+idIndex+'" placeholder="Desconhecido" '+
          'disabled value="$REPLACE_LICENSE_STATUS_VAL">'+
          '</input>'+
          '<div class="input-group-append">'+
            '<button class="btn btn-primary mr-0 my-0 btn-license-status-refresh" type="button">' +
              '<i class="fas fa-sync-alt"></i>'+
            '</button>'+
          '</div>'+
          '<div class="invalid-feedback"></div>'+
        '</div>':
        ''
        )+
        (mesh > -1 ?
          '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="text-primary active">Canal do Wi-Fi 2.4GHz</label>'+
                '<select class="browser-default md-select" id="edit_wifi_channel-'+idIndex+'" '+
                '$REPLACE_WIFI_EN>'+
                  '<option value="auto" $REPLACE_SELECTED_CHANNEL_auto$>auto</option>'+
                  '<option value="1" $REPLACE_SELECTED_CHANNEL_1$>1</option>'+
                  '<option value="2" $REPLACE_SELECTED_CHANNEL_2$>2</option>'+
                  '<option value="3" $REPLACE_SELECTED_CHANNEL_3$>3</option>'+
                  '<option value="4" $REPLACE_SELECTED_CHANNEL_4$>4</option>'+
                  '<option value="5" $REPLACE_SELECTED_CHANNEL_5$>5</option>'+
                  '<option value="6" $REPLACE_SELECTED_CHANNEL_6$>6</option>'+
                  '<option value="7" $REPLACE_SELECTED_CHANNEL_7$>7</option>'+
                  '<option value="8" $REPLACE_SELECTED_CHANNEL_8$>8</option>'+
                  '<option value="9" $REPLACE_SELECTED_CHANNEL_9$>9</option>'+
                  '<option value="10" $REPLACE_SELECTED_CHANNEL_10$>10</option>'+
                  '<option value="11" $REPLACE_SELECTED_CHANNEL_11$>11</option>'+
                  (hasExtendedChannels ?
                    '<option value="12" $REPLACE_SELECTED_CHANNEL_12$>12</option>'+
                    '<option value="13" $REPLACE_SELECTED_CHANNEL_13$>13</option>':
                    ''
                  )+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>'+
          '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="text-primary active">Canal do Wi-Fi 5.0GHz</label>'+
                '<select class="browser-default md-select" id="edit_wifi5_channel-'+idIndex+'" '+
                '$REPLACE_WIFI5_EN>'+
                  '<option value="auto" $REPLACE_SELECTED_CHANNEL5_auto$>auto</option>'+
                  '<option value="36" $REPLACE_SELECTED_CHANNEL5_36$>36</option>'+
                  '<option value="40" $REPLACE_SELECTED_CHANNEL5_40$>40</option>'+
                  '<option value="44" $REPLACE_SELECTED_CHANNEL5_44$>44</option>'+
                  '<option value="48" $REPLACE_SELECTED_CHANNEL5_48$>48</option>'+
                  '<option value="52" $REPLACE_SELECTED_CHANNEL5_52$>52</option>'+
                  '<option value="56" $REPLACE_SELECTED_CHANNEL5_56$>56</option>'+
                  '<option value="60" $REPLACE_SELECTED_CHANNEL5_60$>60</option>'+
                  '<option value="64" $REPLACE_SELECTED_CHANNEL5_64$>64</option>'+
                  '<option value="149" $REPLACE_SELECTED_CHANNEL5_149$>149</option>'+
                  '<option value="153" $REPLACE_SELECTED_CHANNEL5_153$>153</option>'+
                  '<option value="157" $REPLACE_SELECTED_CHANNEL5_157$>157</option>'+
                  '<option value="161" $REPLACE_SELECTED_CHANNEL5_161$>161</option>'+
                  '<option value="165" $REPLACE_SELECTED_CHANNEL5_165$>165</option>'+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>':
          ''
        )+
      '</div>'+
      '<div class="col-6">'+
        '$REPLACE_RESET_DATE'+
        '<div class="md-form input-entry pt-1">'+
          '<label class="active">Modelo</label>'+
          '<input class="form-control" type="text" maxlength="32" '+
          'disabled value="'+device.model+'">'+
          '<div class="invalid-feedback"></div>'+
        '</div>'+
        '<div class="md-form input-entry">'+
          '<label class="active">'+
            ((isTR069) ? 'Versão do Firmware' : 'Versão do Flashbox')+
          '</label>'+
          '<input class="form-control" type="text" maxlength="32" '+
          'disabled value="'+device.version+'">'+
          '<div class="invalid-feedback"></div>'+
        '</div>'+
        (mesh > -1 ?
          '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="text-primary active">Potência do sinal 2.4GHz</label>'+
                '<select class="browser-default md-select" id="edit_wifi_power-'+idIndex+'" '+
                '$REPLACE_WIFI_POWER_EN>'+
                  '<option value="100" $REPLACE_SELECTED_POWER_100$>100%</option>'+
                  '<option value="75"  $REPLACE_SELECTED_POWER_75$>75%</option>'+
                  '<option value="50"  $REPLACE_SELECTED_POWER_50$>50%</option>'+
                  '<option value="25"  $REPLACE_SELECTED_POWER_25$>25%</option>'+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>'+
          '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="text-primary active">Potência do sinal 5.0GHz</label>'+
                '<select class="browser-default md-select" id="edit_wifi5_power-'+idIndex+'" '+
                '$REPLACE_WIFI5_POWER_EN>'+
                  '<option value="100" $REPLACE_SELECTED_POWER5_100$>100%</option>'+
                  '<option value="75"  $REPLACE_SELECTED_POWER5_75$>75%</option>'+
                  '<option value="50"  $REPLACE_SELECTED_POWER5_50$>50%</option>'+
                  '<option value="25"  $REPLACE_SELECTED_POWER5_25$>25%</option>'+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>':
          ''
        )+
      '</div>'+
    '</div>';
    if (!isTR069) {
      aboutTab = aboutTab.replace('$REPLACE_RESET_DATE', lastReset);
    } else {
      aboutTab = aboutTab.replace('$REPLACE_RESET_DATE', '');
    }
    if (device.external_reference) {
      aboutTab = aboutTab.replace('$REPLACE_ID_VAL', device.external_reference.data);
    } else {
      aboutTab = aboutTab.replace('$REPLACE_ID_VAL', '');
    }
    if (device.is_license_active !== undefined) {
      let licenseStatusStr = device.is_license_active ? 'Ativa':'Bloqueada';
      aboutTab = aboutTab.replace('$REPLACE_LICENSE_STATUS_VAL', licenseStatusStr);
    } else {
      aboutTab = aboutTab.replace('$REPLACE_LICENSE_STATUS_VAL', 'Desconhecido');
    }
    if (!device.external_reference || device.external_reference.kind === 'CPF') {
      aboutTab = aboutTab.replace('$REPLACE_ID_CPF', 'primary-color active');
      aboutTab = aboutTab.replace('$REPLACE_ID_CNPJ', '');
      aboutTab = aboutTab.replace('$REPLACE_ID_OTHER', '');
    } else if (device.external_reference && device.external_reference.kind === 'CNPJ') {
      aboutTab = aboutTab.replace('$REPLACE_ID_CPF', '');
      aboutTab = aboutTab.replace('$REPLACE_ID_CNPJ', 'primary-color active');
      aboutTab = aboutTab.replace('$REPLACE_ID_OTHER', '');
    } else if (device.external_reference && device.external_reference.kind === 'Outro') {
      aboutTab = aboutTab.replace('$REPLACE_ID_CPF', '');
      aboutTab = aboutTab.replace('$REPLACE_ID_CNPJ', '');
      aboutTab = aboutTab.replace('$REPLACE_ID_OTHER', 'primary-color active');
    }
    // Channel change only possible in cable only mesh mode
    if ((!isSuperuser && grantWifiInfo <= 1) || (device.mesh_mode !== 1)) {
      aboutTab = aboutTab.replace(/\$REPLACE_WIFI_EN/g, 'disabled');
    } else {
      aboutTab = aboutTab.replace(/\$REPLACE_WIFI_EN/g, '');
    }
    if (!device.permissions.grantWifiPowerHiddenIpv6Box ||
       (!isSuperuser && grantWifiInfo <= 1)) {
      aboutTab = aboutTab.replace(/\$REPLACE_WIFI_POWER_EN/g, 'disabled');
      aboutTab = aboutTab.replace(/\$REPLACE_WIFI5_POWER_EN/g, 'disabled');
    } else {
      aboutTab = aboutTab.replace(/\$REPLACE_WIFI_POWER_EN/g, '');
      if (device.wifi_channel_5ghz == 'auto') {
        aboutTab = aboutTab.replace(/\$REPLACE_WIFI5_POWER_EN/g, 'disabled');
      } else {
        aboutTab = aboutTab.replace(/\$REPLACE_WIFI5_POWER_EN/g, '');
      }
    }

    let selectTarget = '$REPLACE_SELECTED_CHANNEL_' + device.wifi_channel;
    aboutTab = aboutTab.replace(selectTarget, 'selected="selected"');
    aboutTab = aboutTab.replace(/\$REPLACE_SELECTED_CHANNEL_.*?\$/g, '');
    selectTarget = '$REPLACE_SELECTED_CHANNEL5_' + device.wifi_channel_5ghz;
    aboutTab = aboutTab.replace(selectTarget, 'selected="selected"');
    aboutTab = aboutTab.replace(/\$REPLACE_SELECTED_CHANNEL5_.*?\$/g, '');
    selectTarget = '$REPLACE_SELECTED_POWER_' + device.wifi_power;
    aboutTab = aboutTab.replace(selectTarget, 'selected="selected"');
    aboutTab = aboutTab.replace(/\$REPLACE_SELECTED_POWER_.*?\$/g, '');
    selectTarget = '$REPLACE_SELECTED_POWER5_' + device.wifi_power_5ghz;
    aboutTab = aboutTab.replace(selectTarget, 'selected="selected"');
    aboutTab = aboutTab.replace(/\$REPLACE_SELECTED_POWER5_.*?\$/g, '');

    return aboutTab;
  };

  let loadDevicesTable = function(selelectedPage=1, filterList='') {
    let deviceTableContent = $('#devices-table-content');
    let deviceTablePagination = $('#devices-table-pagination');
    // Clean all elements before loading
    deviceTableContent.empty();
    deviceTablePagination.empty();
    // Start loading animation
    deviceTableContent.append(
      $('<tr>').append(
        $('<td>').attr('colspan', '12')
        .addClass('grey lighten-5 text-center')
        .append(
          $('<h3>').append(
            $('<i>').addClass('fas fa-spinner fa-pulse fa-2x grey-text'),
          ),
        ),
      ),
    );
    $.ajax({
      url: '/devicelist/search?page=' + selelectedPage,
      type: 'PUT',
      data: {filter_list: filterList},
      success: function(res) {
        if (res.type !== 'success') {
          displayAlertMsg(res);
          return;
        }
        // show or not ssid prefix in new device form
        $('#ssid_prefix').text(res.ssidPrefix);
        $('#ssid_prefix').data('isenabled', res.isSsidPrefixEnabled);
        if (res.isSsidPrefixEnabled) {
          $('#ssid_prefix_div').removeClass('d-none');
          $('#ssid_prefix_div').addClass('d-block');
          $('#ssid_label').addClass('active');
        }
        // Stop loading animation
        deviceTableContent.empty();
        // Just fill not found message if there are no devices found
        if (res.devices.length == 0) {
          deviceTableContent.html(
            '<tr><td class="grey lighten-5 text-center" colspan="12">'+
              '<h5>Nenhum CPE encontrado</h5>'+
            '</td></tr>',
          );
          // Attach elements back to DOM after manipulation
          $('#devices-table').append(deviceTableContent);
          return false;
        }

        // fill amount of devices from result.
        fillTotalDevicesFromSearch(res.status.totalnum);

        // Fill multiple update form
        updateSearchResultsScheduler(res);
        let finalHtml = '';
        // Fill status row
        let allUpgrade = '<td>'+
          '<div class="btn-group">'+
            '<div class="btn-group" id="all-devices">'+
              '<button class="btn btn-primary btn-sm px-3 py-2 teal darken-5" id="btn-upgrade-scheduler">'+
                '<i class="fas fa-clock fa-lg"></i>'+
                '<span>&nbsp; &nbsp; Atualizar Vários</span>'+
              '</button>'+
            '</div>'+
          '</div>'+
        '</td>';
        let searchSummary = '<td class="text-center">'+
          res.status.totalnum+' total'+
        '</td><td>'+
          '<div class="fas fa-circle green-text"></div>'+
          '<span>&nbsp;</span>'+
          '<a href="#" id="online-status-sum">'+res.status.onlinenum+'</a>'+
          '<br>'+
          '<div class="fas fa-circle red-text"></div>'+
          '<span>&nbsp;</span>'+
          '<a href="#" id="recovery-status-sum">'+res.status.recoverynum+'</a>'+
          '<br>'+
          '<div class="fas fa-circle grey-text"></div>'+
          '<span>&nbsp;</span>'+
          '<a href="#" id="offline-status-sum">'+res.status.offlinenum+'</a>'+
        '</td>';

        let statusRow = '<tr class="not-selectable-device-row">'+
          '<td class="pl-1 pr-0">'+
            '<a id="refresh-table-content">'+
              '<div class="fas fa-sync-alt fa-lg mt-2 hover-effect"></div>'+
            '</a>'+
          '</td>'+
          '$REPLACE_SEARCHSUMMARY'+
          '<td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>'+
          '$REPLACE_ALLUPDATE'+
        '</tr>';
        if (isSuperuser || grantShowSearchSummary) {
          statusRow = statusRow.replace('$REPLACE_SEARCHSUMMARY',
                                        searchSummary);
        } else {
          statusRow = statusRow.replace('$REPLACE_SEARCHSUMMARY',
                                        '<td></td><td></td>');
        }
        if (isSuperuser || (grantFirmwareUpgrade && grantMassFirmwareUpgrade)) {
          statusRow = statusRow.replace('$REPLACE_ALLUPDATE', allUpgrade);
        } else {
          statusRow = statusRow.replace('$REPLACE_ALLUPDATE', '');
        }
        finalHtml += statusRow;
        let index = 0;
        // Fill remaining rows with devices
        for (let idx = 0; idx < res.devices.length; idx += 1) {
          let device = res.devices[idx];
          if (device.mesh_master !== '' && device.mesh_master !== undefined) {
            // Skip mesh slaves, master draws their form
            continue;
          }
          let isTR069 = device.use_tr069;
          let ponRXPower = device.pon_rxpower;
          let grantWifiBand = device.permissions.grantWifiBand;
          let grantWifiBandAuto = device.permissions.grantWifiBandAuto;
          let grantWifi5ghz = device.permissions.grantWifi5ghz;
          let grantWifiState = device.permissions.grantWifiState;
          let grantWifiPowerHiddenIpv6Box =
            (device.use_tr069) ? false :
            device.permissions.grantWifiPowerHiddenIpv6Box;
          let grantWifiExtendedChannels =
            device.permissions.grantWifiExtendedChannels;
          let grantLanEdit = device.permissions.grantLanEdit;
          let grantLanGwEdit = device.permissions.grantLanGwEdit;
          let grantOpmode = device.permissions.grantOpmode;
          let grantPortForwardAsym = device.permissions.grantPortForwardAsym;
          let grantPortOpenIpv6 = device.permissions.grantPortOpenIpv6;
          let grantViewLogs = device.permissions.grantViewLogs;
          let grantResetDevices = device.permissions.grantResetDevices;
          let grantPortForward = device.permissions.grantPortForward;
          let grantPingTest = device.permissions.grantPingTest;
          let grantLanDevices = device.permissions.grantLanDevices;
          let grantSiteSurvey = device.permissions.grantSiteSurvey;
          let grantUpnpSupport = device.permissions.grantUpnp;
          let grantDeviceSpeedTest = device.permissions.grantSpeedTest;
          let grantVlanSupport = device.permissions.grantVlanSupport;
          let grantWanBytesSupport = device.permissions.grantWanBytesSupport;
          let grantPonSignalSupport = device.permissions.grantPonSignalSupport;
          let grantMeshMode = device.permissions.grantMeshMode;

          let rowAttr = buildRowData(device, index);
          let statusClasses = buildStatusClasses(device);
          let statusAttributes = buildStatusAttributes(device);
          let notifications = buildNotification();

          let slaves = [];
          let isSelectableRow = true;
          if (device.mesh_slaves && device.mesh_slaves.length > 0) {
            slaves = device.mesh_slaves.map((s)=>res.devices.find((d)=>d._id===s));
            isSelectableRow = false;
          }
          if (!isSuperuser && !grantDeviceMassRemoval) {
            isSelectableRow = false;
          }
          let upgradeCol = buildUpgradeCol(device, slaves, isTR069);
          let ponSignalCol = buildPonSignalColumn(device, grantPonSignalSupport);
          let infoRow = buildTableRowInfo(device, isSelectableRow,
                                          false, 0, isTR069);
          infoRow = infoRow.replace('$REPLACE_ATTRIBUTES', rowAttr);
          infoRow = infoRow.replace('$REPLACE_COLOR_CLASS', statusClasses);
          infoRow = infoRow.replace('$REPLACE_COLOR_ATTR', statusAttributes);
          if (isSuperuser || grantNotificationPopups) {
            infoRow = infoRow.replace('$REPLACE_NOTIFICATIONS', notifications);
          } else {
            infoRow = infoRow.replace('$REPLACE_NOTIFICATIONS', '');
          }
          if (isSuperuser || grantFirmwareUpgrade) {
            infoRow = infoRow.replace('$REPLACE_UPGRADE', upgradeCol);
          } else {
            infoRow = infoRow.replace('$REPLACE_UPGRADE', '');
          }
          if (isTR069) {
            infoRow = infoRow.replace('$REPLACE_COLOR_CLASS_PILL', 'darken-2');
            infoRow = infoRow.replace('$REPLACE_PILL_TEXT', 'TR-069');
            if (isSuperuser || grantPonSignalSupport) {
              infoRow = infoRow.replace('$REPLACE_PONSIGNAL', ponSignalCol);
            }
          } else {
            infoRow = infoRow.replace('$REPLACE_COLOR_CLASS_PILL', 'lighten-2');
            infoRow = infoRow.replace('$REPLACE_PILL_TEXT', 'Flashbox');
          }

          finalHtml += infoRow;

          let formAttr = 'id="form-'+index+'"';
          formAttr += ' data-index="'+index+'"';
          formAttr += ' data-deviceid="'+device._id+'"';
          formAttr += ' data-serialid="'+device.serial_tr069+'"';
          formAttr += ' data-lan-subnet="'+device.lan_subnet+'"';
          formAttr += ' data-lan-submask="'+device.lan_netmask+'"';
          formAttr += ' data-is-tr069="'+device.use_tr069+'"';
          formAttr += ' data-slave-count="'+((device.mesh_slaves) ? device.mesh_slaves.length : 0)+'"';
          formAttr += ' data-slaves="'+((device.mesh_slaves) ? JSON.stringify(device.mesh_slaves).replace(/"/g, '$') : '')+'"';
          formAttr += ' data-validate-wifi="'+(isSuperuser || grantWifiInfo >= 1)+'"';
          formAttr += ' data-validate-pppoe="'+(isSuperuser || grantPPPoEInfo >= 1)+'"';
          formAttr += ' data-validate-ipv6-enabled="'+grantWifiPowerHiddenIpv6Box+'"';
          formAttr += ' data-validate-wifi-band="'+(grantWifiBand && (isSuperuser || grantWifiInfo >= 1))+'"';
          formAttr += ' data-validate-wifi-5ghz="'+(grantWifi5ghz && (isSuperuser || grantWifiInfo >= 1))+'"';
          formAttr += ' data-validate-wifi-power="'+(!device.use_tr069 && grantWifiPowerHiddenIpv6Box && (isSuperuser || grantWifiInfo >= 1))+'"';
          formAttr += ' data-validate-lan="'+grantLanEdit+'"';
          formAttr += ' data-validate-vlan-access="'+(isSuperuser?2:grantVlan)+'"';
          formAttr += ' data-validate-port-forward-asym="'+grantPortForwardAsym+'"';
          formAttr += ' data-validate-port-open-ipv6="'+grantPortOpenIpv6+'"';
          formAttr += ' data-validate-upnp="'+grantUpnpSupport+'"';
          formAttr += ' data-minlength-pass-pppoe="'+res.min_length_pass_pppoe+'"';
          formAttr += ' data-bridge-enabled="'+(device.bridge_mode_enabled ? 'Sim' : 'Não')+'"';
          formAttr += ' data-has-5ghz="'+grantWifi5ghz+'"';
          formAttr += ' data-has-extended-channels="'+grantWifiExtendedChannels+'"';
          formAttr += ' data-device-model="'+(device.model ? device.model : '')+'"';
          formAttr += ' data-device-version="'+(device.version ? device.version : '')+'"';
          formAttr += ' data-qtd-ports="'+(device.qtdPorts ? device.qtdPorts : '')+'"';
          if (device.data_collecting !== undefined) {
            formAttr += ' data-data_collecting-is_active="'+(device.data_collecting.is_active ? 'true' : 'false')+'"';
            formAttr += ' data-data_collecting-has_latency="'+(device.data_collecting.has_latency ? 'true' : 'false')+'"';
            formAttr += ' data-data_collecting-ping_fqdn="'+(device.data_collecting.ping_fqdn || '')+'"';
          }

          let baseAction = '<div class="dropdown-divider"></div><a class="dropdown-item $REPLACE_BTN_CLASS"><i class="fas $REPLACE_ICON"></i><span>&nbsp $REPLACE_TEXT</span></a>';

          let logAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-log-modal')
          .replace('$REPLACE_ICON', 'fa-file-alt')
          .replace('$REPLACE_TEXT', 'Logs do CPE');

          let unblockAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-reset-blocked')
          .replace('$REPLACE_ICON', 'fa-ban')
          .replace('$REPLACE_TEXT', 'Desbloquear dispositivos');

          let portForwardAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-open-ports-modal')
          .replace('$REPLACE_ICON', 'fa-lock-open')
          .replace('$REPLACE_TEXT', 'Abertura de portas');

          let portForwardTr069Action = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-port-forward-tr069-modal')
          .replace('$REPLACE_ICON', 'fa-lock-open')
          .replace('$REPLACE_TEXT', 'Abertura de portas');

          let pingTestAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-ping-test-modal')
          .replace('$REPLACE_ICON', 'fa-stethoscope')
          .replace('$REPLACE_TEXT', 'Teste de latência e perda');

          let devicesAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-lan-devices-modal')
          .replace('$REPLACE_ICON', 'fa-network-wired')
          .replace('$REPLACE_TEXT', 'Dispositivos Conectados');

          let siteSurveyAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-site-survey-modal')
          .replace('$REPLACE_ICON', 'fa-wifi')
          .replace('$REPLACE_TEXT', 'Redes ao redor');

          let measureAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-throughput-measure-modal')
          .replace('$REPLACE_ICON', 'fa-tachometer-alt')
          .replace('$REPLACE_TEXT', 'Medição de Velocidade');

          let vlanAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-vlan-modal')
          .replace('$REPLACE_ICON', 'fa-project-diagram')
          .replace('$REPLACE_TEXT', 'Administrar VLANs');

          let wanBytesAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-wan-bytes-modal')
          .replace('$REPLACE_ICON', 'fa-chart-line')
          .replace('$REPLACE_TEXT', 'Tráfego WAN');

          let ponSignalAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-pon-signal-modal')
          .replace('$REPLACE_ICON', 'fa-wave-square')
          .replace('$REPLACE_TEXT', 'Sinal Óptico');

          let factoryAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-factory red-text')
          .replace('$REPLACE_ICON', 'fa-skull-crossbones')
          .replace('$REPLACE_TEXT', 'Voltar à firmware de fábrica');

          let dataCollectingAction = baseAction
          .replace('$REPLACE_BTN_CLASS', 'btn-data_collecting-device-modal')
          .replace('$REPLACE_ICON', 'fa-chart-bar')
          .replace('$REPLACE_TEXT', 'Coleta de dados');

          let idxMenu = 0;
          let sideMenu = [];
          sideMenu[0] = '<div><a class="dropdown-item btn-reboot"><i class="fas fa-sync"></i><span>&nbsp Reiniciar CPE</span></a>';
          sideMenu[1] = '<div><a class="dropdown-item btn-reset-app"><i class="fas fa-mobile-alt"></i><span>&nbsp Resetar senha App</span></a>';

          if ((isSuperuser || grantLOGAccess) && grantViewLogs) {
            sideMenu[idxMenu] += logAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && !device.bridge_mode_enabled && grantResetDevices) {
            sideMenu[idxMenu] += unblockAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && !device.bridge_mode_enabled && grantPortForward) {
            sideMenu[idxMenu] += portForwardAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (isTR069 && !device.bridge_mode_enabled && grantPortForward) {
            sideMenu[idxMenu] += portForwardTr069Action;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && grantPingTest) {
            sideMenu[idxMenu] += pingTestAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if ((isSuperuser || grantLanDevsAccess) && grantLanDevices) {
            sideMenu[idxMenu] += devicesAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && (isSuperuser || grantSiteSurveyAccess) && grantSiteSurvey) {
            sideMenu[idxMenu] += siteSurveyAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && (isSuperuser || grantSpeedMeasure >= 1) && grantDeviceSpeedTest) {
            sideMenu[idxMenu] += measureAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!device.bridge_mode_enabled && (isSuperuser || grantVlan > 0) && grantVlanSupport) {
            sideMenu[idxMenu] += vlanAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if ((isSuperuser || grantWanBytes) && grantWanBytesSupport) {
            sideMenu[idxMenu] += wanBytesAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && isSuperuser && enableDataCollecting) {
            sideMenu[idxMenu] += dataCollectingAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (isTR069 && grantPonSignalSupport) {
            sideMenu[idxMenu] += ponSignalAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }
          if (!isTR069 && slaves.length == 0 && (isSuperuser || grantFactoryReset)) {
            sideMenu[idxMenu] += factoryAction;
            idxMenu = ((idxMenu == 0) ? 1 : 0);
          }

          sideMenu[0] += '</div>';
          sideMenu[1] += '</div>';

          let devActions = '<button class="btn btn-primary dropdown-toggle" '+
          'type="button" data-toggle="dropdown">Opções</button>'+
          '<div class="dropdown-menu dropdown-menu-inline'+
          ' dropdown-menu-right" data-dropdown-in="fadeIn" '+
          'data-dropdown-out="fadeOut">'+
            '$REPLACE_LEFT_MENU'+
            '$REPLACE_RIGHT_MENU'+
          '</div>';
          devActions = devActions.replace('$REPLACE_LEFT_MENU', sideMenu[0]);
          devActions = devActions.replace('$REPLACE_RIGHT_MENU', sideMenu[1]);

          let aboutTab = '<div class="edit-tab" id="tab_about-'+index+'">'+
            buildAboutTab(device, index, isTR069, grantWifiExtendedChannels)+
          '</div>';
          if (!isSuperuser && !grantDeviceId) {
            aboutTab = aboutTab.replace(/\$REPLACE_EN_ID/g, 'disabled');
          } else {
            aboutTab = aboutTab.replace(/\$REPLACE_EN_ID/g, '');
          }

          let passwordToggle = '<div class="input-group-append">'+
            '<div class="input-group-text primary-color">'+
              '<a class="toggle-pass"><i class="fas fa-eye-slash white-text"></i></a>'+
            '</div>'+
          '</div>';

          let pppoeForm = '<div class="col-4 $REPLACE_IS_PPPOE" id="edit_pppoe_combo-'+index+'">'+
            '<div class="md-form input-entry">'+
              '<label class="active">Usuário PPPoE</label>'+
              '<input class="form-control" type="text" id="edit_pppoe_user-'+index+'" '+
              'maxlength="64" value="'+device.pppoe_user+'" $REPLACE_PPPOE_FORM_EN></input>'+
              '<div class="invalid-feedback"></div>'+
            '</div>'+
            '<div class="md-form input-entry">'+
              '<div class="input-group">'+
                '<label class="active">Senha PPPoE</label>'+
                '<input class="form-control my-0" type="password" id="edit_pppoe_pass-'+index+'" '+
                'maxlength="64" value="'+device.pppoe_password+'" $REPLACE_PPPOE_FORM_EN></input>'+
                '$REPLACE_PPPOE_PASS'+
                '<div class="invalid-feedback"></div>'+
              '</div>'+
            '</div>'+
          '</div>';
          if (!device.connection_type || device.connection_type.toUpperCase() !== 'PPPOE') {
            pppoeForm = pppoeForm.replace('$REPLACE_IS_PPPOE', 'd-none');
          } else {
            pppoeForm = pppoeForm.replace('$REPLACE_IS_PPPOE', '');
          }
          if (isSuperuser || grantPassShow) {
            pppoeForm = pppoeForm.replace('$REPLACE_PPPOE_PASS', passwordToggle);
          } else {
            pppoeForm = pppoeForm.replace('$REPLACE_PPPOE_PASS', '');
          }
          if (device.bridge_mode_enabled || (!isSuperuser && grantPPPoEInfo <= 1)) {
            pppoeForm = pppoeForm.replace(/\$REPLACE_PPPOE_FORM_EN/g, 'disabled');
          } else {
            pppoeForm = pppoeForm.replace(/\$REPLACE_PPPOE_FORM_EN/g, '');
          }

          let wanTab = '<div class="edit-tab d-none" id="tab_wan-'+index+'">'+
            '<div class="row" $REPLACE_BRIDGE_WARN>'+
              '<div class="col-12">'+
                '<div class="alert alert-warning text-center">'+
                  '<div class="fas fa-exclamation-triangle fa-lg mr-2"></div>'+
                  '<span>'+
                    'Este CPE está em modo bridge! Para alterar os dados da WAN, retire o CPE do modo bridge primeiro.'+
                  '</span>'+
                '</div>'+
              '</div>'+
            '</div>'+
            '<div class="row">'+
              '<div class="col-4">'+
                '<div class="md-form">'+
                  '<div class="input-group has-warning">'+
                    '<div class="md-selectfield form-control my-0">'+
                      '<label class="active">Tipo de Conexão</label>'+
                      '<select class="browser-default md-select" id="edit_connect_type-'+index+'" $REPLACE_EDIT_WAN>'+
                        '<option value="DHCP" $REPLACE_SELECTED_DHCP$>DHCP</option>'+
                        '<option value="PPPoE" $REPLACE_SELECTED_PPPOE$>PPPoE</option>'+
                      '</select>'+
                    '</div>'+
                    '<h7 class="orange-text d-none" id="edit_connect_type_warning-'+index+'">'+
                      'Cuidado! Isso pode deixar o CPE inacessível '+
                      'dependendo das configurações de rede do seu provedor'+
                    '</h7>'+
                  '</div>'+
                '</div>'+
                (isTR069 ?
                  '<div class="md-form input-entry">'+
                    '<label class="active">Intesidade do sinal óptico (RXPower/Recebido)</label>'+
                    '<input class="form-control" type="text" maxlength="3" '+
                    'value="'+
                    ((ponRXPower) ? ponRXPower + ' dBm' : 'Não disponível')+
                    '" disabled></input>'+
                    '<div class="invalid-feedback"></div>'+
                  '</div>':
                  ''
                )+
                '<div class="custom-control custom-checkbox" $REPLACE_IPV6_ENABLED_EN>'+
                  '<input class="custom-control-input" type="checkbox" id="edit_ipv6_enabled-'+index+'" '+
                  '$REPLACE_SELECTED_IPV6_ENABLED></input>'+
                  '<label class="custom-control-label" for="edit_ipv6_enabled-'+index+'">'+
                  'Habilitar IPv6'+
                  '</label>'+
                '</div>'+
              '</div>'+
              '<div class="col-4">'+
                '<div class="md-form input-entry">'+
                  '<label class="active">Velocidade Negociada (Mbps)</label>'+
                  '<input class="form-control" type="text" maxlength="32" '+
                  'value="'+
                  ((device.wan_negociated_speed) ? device.wan_negociated_speed : 'Não disponível')+
                  '" disabled></input>'+
                  '<div class="invalid-feedback"></div>'+
                '</div>'+
                '<div class="md-form input-entry">'+
                  '<label class="active">Modo de Transmissão (Duplex)</label>'+
                  '<input class="form-control" type="text" maxlength="32" '+
                  'value="'+
                  ((device.wan_negociated_duplex) ? device.wan_negociated_duplex : 'Não disponível')+
                  '" disabled></input>'+
                  '<div class="invalid-feedback"></div>'+
                '</div>'+
              '</div>'+
              '$REPLACE_PPPOE_FORM'+
            '</div>'+
          '</div>';
          if (device.connection_type && device.connection_type.toUpperCase() === 'PPPOE') {
            wanTab = wanTab.replace('$REPLACE_SELECTED_PPPOE', 'selected="selected"');
          } else {
            wanTab = wanTab.replace('$REPLACE_SELECTED_DHCP', 'selected="selected"');
          }

          let currIpv6Enabled = (parseInt(device.ipv6_enabled) == 1 ? 'checked' : '');
          wanTab = wanTab.replace(/\$REPLACE_SELECTED_IPV6_ENABLED/g, currIpv6Enabled);

          if (!grantWifiPowerHiddenIpv6Box) {
            wanTab = wanTab.replace('$REPLACE_IPV6_ENABLED_EN', 'style="display: none;"');
          } else {
            wanTab = wanTab.replace('$REPLACE_IPV6_ENABLED_EN', '');
          }

          if (device.bridge_mode_enabled) {
            wanTab = wanTab.replace('$REPLACE_EDIT_WAN', 'disabled');
            wanTab = wanTab.replace('$REPLACE_BRIDGE_WARN', '');
          } else if (isTR069 || (!isSuperuser && !grantWanType)) {
            wanTab = wanTab.replace('$REPLACE_EDIT_WAN', 'disabled');
            wanTab = wanTab.replace('$REPLACE_BRIDGE_WARN', 'style="display: none;"');
          } else {
            wanTab = wanTab.replace('$REPLACE_EDIT_WAN', '');
            wanTab = wanTab.replace('$REPLACE_BRIDGE_WARN', 'style="display: none;"');
          }
          wanTab = wanTab.replace(/\$REPLACE_SELECTED_.*?\$/g, '');
          if (isSuperuser || grantPPPoEInfo >= 1) {
            wanTab = wanTab.replace('$REPLACE_PPPOE_FORM', pppoeForm);
          } else {
            wanTab = wanTab.replace('$REPLACE_PPPOE_FORM', '');
          }

          let lanTab = '<div class="edit-tab d-none" id="tab_lan-'+index+'">'+
            '<div class="row" $REPLACE_BRIDGE_WARN>'+
              '<div class="col-12">'+
                '<div class="alert alert-warning text-center">'+
                  '<div class="fas fa-exclamation-triangle fa-lg mr-2"></div>'+
                  '<span>'+
                    'Este CPE está em modo bridge! Para alterar os dados da LAN, retire o CPE do modo bridge primeiro.'+
                  '</span>'+
                '</div>'+
              '</div>'+
            '</div>'+
            '<div class="row">'+
              '<div class="col-6">'+
                '<div class="md-form input-entry">'+
                  '<label class="active">'+
                    (grantLanGwEdit ? 'IP do CPE' : 'IP da Rede')+
                  '</label>'+
                  '<input class="form-control ip-mask-field" type="text" id="edit_lan_subnet-'+index+'" '+
                  'maxlength="15" value="'+device.lan_subnet+'" $REPLACE_LAN_EN></input>'+
                  '<div class="invalid-feedback"></div>'+
                '</div>'+
                (grantLanGwEdit ?
                  '<div class="alert alert-info">'+
                    '<div class="fas fa-info-circle fa-lg mr-2"></div>'+
                    '<span>IP da rede será calculado a partir do IP do CPE e Máscara escolhidos</span>'+
                  '</div>' :
                  ''
                )+
              '</div>'+
              '<div class="col-6">'+
                '<div class="md-form input-group">'+
                  '<div class="md-selectfield form-control my-0">'+
                    '<label class="active">Máscara</label>'+
                    '<select class="browser-default md-select" type="text" id="edit_lan_netmask-'+index+'" '+
                    'maxlength="15" $REPLACE_LAN_EN>'+
                      '<option value="24" $REPLACE_SELECTED_24$>24</option>'+
                      '<option value="25" $REPLACE_SELECTED_25$>25</option>'+
                      '<option value="26" $REPLACE_SELECTED_26$>26</option>'+
                    '</select>'+
                  '</div>'+
                '</div>'+
              '</div>'+
            '</div>'+
          '</div>';
          if (device.bridge_mode_enabled || !grantLanEdit || (!isSuperuser && !grantLanEditAccess)) {
            lanTab = lanTab.replace(/\$REPLACE_LAN_EN/g, 'disabled');
          } else {
            lanTab = lanTab.replace(/\$REPLACE_LAN_EN/g, '');
          }
          if (device.bridge_mode_enabled) {
            lanTab = lanTab.replace('$REPLACE_BRIDGE_WARN', '');
          } else {
            lanTab = lanTab.replace('$REPLACE_BRIDGE_WARN', 'style="display: none;"');
          }
          let selectTarget = '$REPLACE_SELECTED_' + device.lan_netmask;
          lanTab = lanTab.replace(selectTarget, 'selected="selected"');
          lanTab = lanTab.replace(/\$REPLACE_SELECTED_.*?\$/g, '');

          let meshForm = '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="active">Mesh</label>'+
                '<select class="browser-default md-select" type="text" id="edit_meshMode-'+index+'" '+
                'maxlength="15" $REPLACE_OPMODE_EN>'+
                  '<option value="0" $REPLACE_SELECTED_MESH_0$>Desabilitado</option>'+
                  '<option value="1" $REPLACE_SELECTED_MESH_1$>Cabo</option>'+
                  '<option value="2" $REPLACE_SELECTED_MESH_2$>Cabo e Wi-Fi 2.4 GHz</option>'+
                  '<option value="3" $REPLACE_SELECTED_MESH_3$>Cabo e Wi-Fi 5.0 GHz</option>'+
                  '<option value="4" $REPLACE_SELECTED_MESH_4$>Cabo e ambos Wi-Fi</option>'+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>';

          let opmodeTab = '<div class="edit-tab d-none" id="tab_opmode-'+index+'">'+
            '<div class="row">'+
              '<div class="col-6">'+
                '<div class="md-form">'+
                  '<div class="input-group">'+
                    '<div class="md-selectfield form-control my-0">'+
                      '<label class="active">Modo de Operação</label>'+
                      '<select class="browser-default md-select" type="text" id="edit_opmode-'+index+'" '+
                      'maxlength="15" $REPLACE_OPMODE_EN $REPLACE_MESH_OPMODE_EN>'+
                        '<option value="Modo Roteador" $REPLACE_SELECTED_ROUTER$>Modo Roteador</option>'+
                        '<option value="Modo Bridge" $REPLACE_SELECTED_BRIDGE$>Modo Bridge / Modo AP</option>'+
                      '</select>'+
                    '</div>'+
                  '</div>'+
                '</div>'+
                '$REPLACE_MESH_MODE'+
                '<div $REPLACE_OPMODE_VIS id="edit_opmode_checkboxes-'+index+'">'+
                  '<div class="custom-control custom-checkbox pb-3">'+
                    '<input class="custom-control-input" type="checkbox" id="edit_opmode_switch_en-'+index+'" '+
                    'name="edit_opmode_switch_en-'+index+'" $REPLACE_SELECTED_OPMODE_SWITCH_STATE $REPLACE_OPMODE_EN></input>'+
                    '<label class="custom-control-label" for="edit_opmode_switch_en-'+index+'">'+
                      'Habilitar portas de rede LAN do CPE'+ // Changed to Enable instead Disable
                    '</label>'+
                  '</div>'+
                  '<div class="custom-control custom-checkbox pb-3">'+
                    '<input class="custom-control-input" type="checkbox"  id="edit_opmode_fixip_en-'+index+'" '+
                    'name="edit_opmode_fixip_en-'+index+'" $REPLACE_SELECTED_OPMODE_IP_STATE $REPLACE_OPMODE_EN></input>'+
                    '<label class="custom-control-label" for="edit_opmode_fixip_en-'+index+'">'+
                      'Fixar o IP do CPE em bridge'+
                    '</label>'+
                  '</div>'+
                  '<div class="alert alert-info mt-3">'+
                    '<div class="fas fa-info-circle fa-lg mr-2"></div>'+
                    '<span>'+
                      'Para garantir o funcionamento em modo bridge, o dispositivo à frente do '+
                      'Flashbox na sua rede deve possuir um servidor DHCP tanto para IPv4 quanto para IPv6'+
                    '</span>'+
                  '</div>'+
                '</div>'+
              '</div>'+
              '<div class="col-6">'+
                '<div $REPLACE_OPMODE_IP_VIS id="edit_opmode_alert_ip-'+index+'">'+
                  '<div class="md-form input-entry">'+
                    '<label class="active">'+
                      'IP fixo do CPE em bridge'+
                    '</label>'+
                    '<input class="form-control ip-mask-field" type="text" id="edit_opmode_fixip-'+index+'" '+
                    'maxlength="15" value="$REPLACE_OPMODE_IP_VAL" $REPLACE_OPMODE_EN></input>'+
                    '<div class="invalid-feedback"></div>'+
                  '</div>'+
                  '<div class="md-form input-entry">'+
                    '<label class="active">'+
                      'IP do gateway para o CPE em bridge'+
                    '</label>'+
                    '<input class="form-control ip-mask-field" type="text" id="edit_opmode_fixip_gateway-'+index+'" '+
                    'maxlength="15" value="$REPLACE_OPMODE_GATEWAY_VAL" $REPLACE_OPMODE_EN></input>'+
                    '<div class="invalid-feedback"></div>'+
                  '</div>'+
                  '<div class="md-form input-entry">'+
                    '<label class="active">'+
                      'IP do DNS para o CPE em bridge'+
                    '</label>'+
                    '<input class="form-control ip-mask-field" type="text" id="edit_opmode_fixip_dns-'+index+'" '+
                    'maxlength="15" value="$REPLACE_OPMODE_DNS_VAL" $REPLACE_OPMODE_EN></input>'+
                    '<div class="invalid-feedback"></div>'+
                  '</div>'+
                  '<div class="alert alert-warning">'+
                    '<div class="fas fa-exclamation-triangle fa-lg mr-2"></div>'+
                    '<span>'+
                      'Cuidado! Garanta que sua rede está configurada para entregar o IP fixo escolhido, '+
                      'senão o CPE pode ficar inacessível!'+
                    '</span>'+
                  '</div>'+
                '</div>'+
              '</div>'+
            '</div>'+
          '</div>';
          if (!isSuperuser && !grantOpmodeEdit) {
            opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_EN/g, 'disabled');
            meshForm = meshForm.replace(/\$REPLACE_OPMODE_EN/g, 'disabled');
          } else {
            opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_EN/g, '');
            meshForm = meshForm.replace(/\$REPLACE_OPMODE_EN/g, '');
          }
          // Disable mode if there are routers in mesh connected
          if (device.mesh_slaves && device.mesh_slaves.length > 0) {
            opmodeTab = opmodeTab.replace(/\$REPLACE_MESH_OPMODE_EN/g, 'disabled');
          } else {
            opmodeTab = opmodeTab.replace(/\$REPLACE_MESH_OPMODE_EN/g, '');
          }
          if (device.bridge_mode_enabled) {
            opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_VIS/g, '');
            opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_BRIDGE', 'selected="selected"');
            opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_ROUTER', '');
            if (device.bridge_mode_switch_disable) {
              opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_OPMODE_SWITCH_STATE', ''); // If disabled, uncheck
            } else {
              opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_OPMODE_SWITCH_STATE', 'checked'); // If enable, check
            }
            if (device.bridge_mode_ip !== '') {
              opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_IP_VIS/g, '');
              opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_OPMODE_IP_STATE', 'checked');
              opmodeTab = opmodeTab.replace('$REPLACE_OPMODE_IP_VAL', device.bridge_mode_ip);
              opmodeTab = opmodeTab.replace('$REPLACE_OPMODE_GATEWAY_VAL', device.bridge_mode_gateway);
              opmodeTab = opmodeTab.replace('$REPLACE_OPMODE_DNS_VAL', device.bridge_mode_dns);
            } else {
              opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_IP_VIS/g, 'style="display: none;"');
              opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_OPMODE_IP_STATE', '');
            }
          } else {
            opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_OPMODE_SWITCH_STATE', 'checked'); // The default value is Enabled when change from Route mode to Bridge mode
            opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_VIS/g, 'style="display: none;"');
            opmodeTab = opmodeTab.replace(/\$REPLACE_OPMODE_IP_VIS/g, 'style="display: none;"');
            opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_ROUTER', 'selected="selected"');
            opmodeTab = opmodeTab.replace('$REPLACE_SELECTED_BRIDGE', '');
          }
          if (grantMeshMode) {
            selectTarget = '$REPLACE_SELECTED_MESH_' + device.mesh_mode;
            meshForm = meshForm.replace(selectTarget, 'selected="selected"');
            meshForm = meshForm.replace(/\$REPLACE_SELECTED_MESH_.*?\$/g, '');
            opmodeTab = opmodeTab.replace('$REPLACE_MESH_MODE', meshForm);
          } else {
            opmodeTab = opmodeTab.replace('$REPLACE_MESH_MODE', '');
          }

          let haveSsidPrefixPrepend =
            '<input class="form-control" type="text" id="edit_wifi_ssid-'+
              index+'" ';
          let haveSsidPrefixPrepend5G =
            '<input class="form-control" type="text" id="edit_wifi5_ssid-'+
              index+'" ';
          let ssidPrefixEnabledCheckbox = '';
          if (device.isToShowSsidPrefixCheckbox) {
            ssidPrefixEnabledCheckbox = '<div id="ssid_prefix_checkbox-'+index+
                '" class="custom-control custom-checkbox pl-2">'+
                '<input class="custom-control-input" type="checkbox" id="edit_is_ssid_prefix_enabled-'+index+'" '+
                '$REPLACE_SSID_PREFIX_ENABLED $REPLACE_SSID_PREFIX_ENABLED_EN></input>'+
                '<label class="custom-control-label ml-3 my-3" for="edit_is_ssid_prefix_enabled-'+index+'">'+
                'Habilitar prefixo SSID'+
                '</label>'+
              '</div>';
            if (device.isSsidPrefixEnabled) {
              haveSsidPrefixPrepend = '<div class="input-group-prepend">'+
                '<span class="input-group-text px-0 text-primary"'+
                ' style="background:inherit;border:none;">'+
                  $('#ssid_prefix').html()+
                '</span>'+
              '</div>'+
              '<input class="form-control pl-0" type="text" id="edit_wifi_ssid-'+index+'" ';

              haveSsidPrefixPrepend5G = '<div class="input-group-prepend">'+
                '<span class="input-group-text px-0 text-primary"'+
                ' style="background:inherit;border:none;">'+
                  $('#ssid_prefix').html()+
                '</span>'+
              '</div>'+
              '<input class="form-control pl-0" type="text" id="edit_wifi5_ssid-'+index+'" ';
            } else {
              haveSsidPrefixPrepend = '<div class="input-group-prepend d-none">'+
                '<span class="input-group-text px-0 text-primary"'+
                ' style="background:inherit;border:none;">'+
                  $('#ssid_prefix').html()+
                '</span>'+
              '</div>'+
              '<input class="form-control pl-0" type="text" id="edit_wifi_ssid-'+index+'" ';

              haveSsidPrefixPrepend5G = '<div class="input-group-prepend d-none">'+
                '<span class="input-group-text px-0 text-primary"'+
                ' style="background:inherit;border:none;">'+
                  $('#ssid_prefix').html()+
                '</span>'+
              '</div>'+
              '<input class="form-control pl-0" type="text" id="edit_wifi5_ssid-'+index+'" ';
            }
          } else {
            ssidPrefixEnabledCheckbox = '<div id="ssid_prefix_checkbox-'+index+
                '" class="custom-control custom-checkbox pl-2 d-none">'+
                '<input class="custom-control-input" type="checkbox" id="edit_is_ssid_prefix_enabled-'+index+'" '+
                '$REPLACE_SSID_PREFIX_ENABLED $REPLACE_SSID_PREFIX_ENABLED_EN></input>'+
                '<label class="custom-control-label" for="edit_is_ssid_prefix_enabled-'+index+'">'+
                'Habilitar prefixo SSID'+
                '</label>'+
              '</div>';
          }

          let wifi5Pane = '';
          let wifi5PaneNav = '';
          if (grantWifi5ghz) {
            wifi5Pane = '<div class="row tab-pane fade" id="wifi5-pane-'+index+'" role="tabpanel" aria-labelledby="wifi5-pane-tab-'+index+'">'+
                  '<div class="col-6">'+
                    '<div class="md-form">'+
                      '<div class="input-group">'+
                        '<div class="md-selectfield form-control my-0">'+
                          '<label class="active">Canal do Wi-Fi</label>'+
                          '<select class="browser-default md-select" id="edit_wifi5_channel-'+index+'" '+
                          '$REPLACE_WIFI5_EN>'+
                            '<option value="auto" $REPLACE_SELECTED_CHANNEL5_auto$>auto</option>'+
                            '<option value="36" $REPLACE_SELECTED_CHANNEL5_36$>36</option>'+
                            '<option value="40" $REPLACE_SELECTED_CHANNEL5_40$>40</option>'+
                            '<option value="44" $REPLACE_SELECTED_CHANNEL5_44$>44</option>'+
                            '<option value="48" $REPLACE_SELECTED_CHANNEL5_48$>48</option>'+
                            '<option value="52" $REPLACE_SELECTED_CHANNEL5_52$>52</option>'+
                            '<option value="56" $REPLACE_SELECTED_CHANNEL5_56$>56</option>'+
                            '<option value="60" $REPLACE_SELECTED_CHANNEL5_60$>60</option>'+
                            '<option value="64" $REPLACE_SELECTED_CHANNEL5_64$>64</option>'+
                            '<option value="149" $REPLACE_SELECTED_CHANNEL5_149$>149</option>'+
                            '<option value="153" $REPLACE_SELECTED_CHANNEL5_153$>153</option>'+
                            '<option value="157" $REPLACE_SELECTED_CHANNEL5_157$>157</option>'+
                            '<option value="161" $REPLACE_SELECTED_CHANNEL5_161$>161</option>'+
                            '<option value="165" $REPLACE_SELECTED_CHANNEL5_165$>165</option>'+
                          '</select>'+
                          '<small class="text-muted" $AUTO_CHANNEL_SELECTED_VISIBILITY5$>'+
                          (device.wifi_last_channel_5ghz ?
                            'Canal escolhido em auto: ' + device.wifi_last_channel_5ghz :
                            ''
                          )+
                          '</small>'+
                        '</div>'+
                      '</div>'+
                    '</div>'+
                    '<div class="md-form input-group input-entry">'+
                      '<label class="active">SSID do Wi-Fi</label>'+
                      haveSsidPrefixPrepend5G+
                      'maxlength="32" value="'+device.wifi_ssid_5ghz+'" $REPLACE_WIFI5_EN></input>'+
                      '<div class="invalid-feedback"></div>'+
                    '</div>'+
                    '<div class="md-form input-entry">'+
                      '<div class="input-group">'+
                        '<label class="active">Senha do Wi-Fi</label>'+
                        '<input class="form-control my-0" type="password" id="edit_wifi5_pass-'+index+'" '+
                        'maxlength="64" value="'+
                        ((device.wifi_password_5ghz) ? device.wifi_password_5ghz : '')+ // treat undefined case
                        '" $REPLACE_WIFI5_EN></input>'+
                        '$REPLACE_WIFI5_PASS'+
                        '<div class="invalid-feedback"></div>'+
                      '</div>'+
                    '</div>'+
                    '<div class="custom-control custom-checkbox">'+
                      '<input class="custom-control-input" type="checkbox" id="edit_wifi5_state-'+index+'" '+
                      '$REPLACE_SELECTED_WIFI5_STATE $REPLACE_WIFI5_STATE_EN></input>'+
                      '<label class="custom-control-label" for="edit_wifi5_state-'+index+'">'+
                      'Ativar Wi-Fi 5.0GHz'+
                      '</label>'+
                    '</div>'+
                    '$REPLACE_WIFI5_HIDDEN'+
                  '</div>'+
                  '<div class="col-6">'+
                    '<div class="md-form">'+
                      '<div class="input-group">'+
                        '<div class="md-selectfield form-control my-0">'+
                          '<label class="active">Largura de banda</label>'+
                          '<select class="browser-default md-select" id="edit_wifi5_band-'+index+'" '+
                          '$REPLACE_WIFI5_EN>'+
                            (grantWifiBandAuto ?
                              '<option value="auto" $REPLACE_SELECTED_BAND5_auto$>auto</option>' :
                              ''
                            )+
                            '<option value="VHT80" $REPLACE_SELECTED_BAND5_VHT80$>80 MHz</option>'+
                            '<option value="VHT40" $REPLACE_SELECTED_BAND5_VHT40$>40 MHz</option>'+
                            '<option value="VHT20" $REPLACE_SELECTED_BAND5_VHT20$>20 MHz</option>'+
                          '</select>'+
                          '<small class="text-muted" $AUTO_BAND_SELECTED_VISIBILITY5$>'+
                          (device.wifi_last_band_5ghz ?
                            'Banda escolhida em auto: ' + device.wifi_last_band_5ghz :
                            ''
                          )+
                          '</small>'+
                        '</div>'+
                      '</div>'+
                    '</div>'+
                    '<div class="md-form">'+
                      '<div class="input-group">'+
                        '<div class="md-selectfield form-control my-0">'+
                          '<label class="active">Modo de operação</label>'+
                          '<select class="browser-default md-select" id="edit_wifi5_mode-'+index+'" '+
                          '$REPLACE_WIFI5_BAND_EN>'+
                            '<option value="11ac" $REPLACE_SELECTED_MODE5_11ac$>AC</option>'+
                            '<option value="11na" $REPLACE_SELECTED_MODE5_11na$>N</option>'+
                          '</select>'+
                        '</div>'+
                      '</div>'+
                    '</div>'+
                    '$REPLACE_WIFI5_POWER'+
                  '</div>'+
                '</div>';
            wifi5PaneNav = '<a class="btn-primary text-white nav-link" id="wifi5-pane-tab-'+index+
              '" data-toggle="tab" href="#wifi5-pane-'+index+
              '" role="tab" aria-controls="#wifi5-pane-'+index+
              '" aria-selected="false">5.0GHz</a>';
          }

          let wifiTab = '<div class="edit-tab d-none" id="tab_wifi-'+index+'">'+
                ssidPrefixEnabledCheckbox+
                '<nav>'+
                  '<div class="nav nav-tabs" id="nav-tab" role="tablist">'+
                    '<a class="btn-primary text-white nav-link active mr-1" id="wifi-pane-tab-'+index+
                      '" data-toggle="tab" href="#wifi-pane-'+index+
                      '" role="tab" aria-controls="#wifi-pane-'+index+
                      '" aria-selected="true">2.4GHz</a>'+
                    wifi5PaneNav+
                  '</div>'+
                '</nav>'+
                '<div class="wifi-tab-content">'+
                  '<div class="row tab-pane fade show active" id="wifi-pane-'+index+'" role="tabpanel" aria-labelledby="wifi-pane-tab-'+index+'">'+
                    '<div class="col-6">'+
                      '<div class="md-form">'+
                        '<div class="input-group">'+
                          '<div class="md-selectfield form-control my-0">'+
                            '<label class="active">Canal do Wi-Fi</label>'+
                            '<select class="browser-default md-select" id="edit_wifi_channel-'+index+'" '+
                            '$REPLACE_WIFI_EN>'+
                              '<option value="auto" $REPLACE_SELECTED_CHANNEL_auto$>auto</option>'+
                              '<option value="1" $REPLACE_SELECTED_CHANNEL_1$>1</option>'+
                              '<option value="2" $REPLACE_SELECTED_CHANNEL_2$>2</option>'+
                              '<option value="3" $REPLACE_SELECTED_CHANNEL_3$>3</option>'+
                              '<option value="4" $REPLACE_SELECTED_CHANNEL_4$>4</option>'+
                              '<option value="5" $REPLACE_SELECTED_CHANNEL_5$>5</option>'+
                              '<option value="6" $REPLACE_SELECTED_CHANNEL_6$>6</option>'+
                              '<option value="7" $REPLACE_SELECTED_CHANNEL_7$>7</option>'+
                              '<option value="8" $REPLACE_SELECTED_CHANNEL_8$>8</option>'+
                              '<option value="9" $REPLACE_SELECTED_CHANNEL_9$>9</option>'+
                              '<option value="10" $REPLACE_SELECTED_CHANNEL_10$>10</option>'+
                              '<option value="11" $REPLACE_SELECTED_CHANNEL_11$>11</option>'+
                              (grantWifiExtendedChannels ?
                                '<option value="12" $REPLACE_SELECTED_CHANNEL_12$>12</option>'+
                                '<option value="13" $REPLACE_SELECTED_CHANNEL_13$>13</option>':
                                ''
                              )+
                            '</select>'+
                            '<small class="text-muted" $AUTO_CHANNEL_SELECTED_VISIBILITY$>'+
                            (device.wifi_last_channel ?
                              'Canal escolhido em auto: ' + device.wifi_last_channel :
                              ''
                            )+
                            '</small>'+
                          '</div>'+
                        '</div>'+
                      '</div>'+
                      '<div class="md-form input-group input-entry">'+
                        '<label class="active">SSID do Wi-Fi</label>'+
                        haveSsidPrefixPrepend+
                        'maxlength="32" value="'+device.wifi_ssid+'" $REPLACE_WIFI_EN></input>'+
                        '<div class="invalid-feedback"></div>'+
                      '</div>'+
                      '<div class="md-form input-entry">'+
                        '<div class="input-group">'+
                          '<label class="active">Senha do Wi-Fi</label>'+
                          '<input class="form-control my-0" type="password" id="edit_wifi_pass-'+index+'" '+
                          'maxlength="64" value="'+
                          ((device.wifi_password) ? device.wifi_password : '')+ // treat undefined case
                          '" $REPLACE_WIFI_EN></input>'+
                          '$REPLACE_WIFI_PASS'+
                          '<div class="invalid-feedback"></div>'+
                        '</div>'+
                      '</div>'+
                      '<div class="custom-control custom-checkbox">'+
                        '<input class="custom-control-input" type="checkbox" id="edit_wifi_state-'+index+'" '+
                        '$REPLACE_SELECTED_WIFI_STATE $REPLACE_WIFI_STATE_EN></input>'+
                        '<label class="custom-control-label" for="edit_wifi_state-'+index+'">'+
                        'Ativar Wi-Fi 2.4GHz'+
                        '</label>'+
                      '</div>'+
                      '$REPLACE_WIFI2_HIDDEN'+
                    '</div>'+
                    '<div class="col-6">'+
                      '<div class="md-form">'+
                        '<div class="input-group">'+
                          '<div class="md-selectfield form-control my-0">'+
                            '<label class="active">Largura de banda</label>'+
                            '<select class="browser-default md-select" id="edit_wifi_band-'+index+'" '+
                            '$REPLACE_WIFI_EN>'+
                              (grantWifiBandAuto ?
                                '<option value="auto" $REPLACE_SELECTED_BAND_auto$>auto</option>':
                                ''
                              )+
                              '<option value="HT40" $REPLACE_SELECTED_BAND_HT40$>40 MHz</option>'+
                              '<option value="HT20" $REPLACE_SELECTED_BAND_HT20$>20 MHz</option>'+
                            '</select>'+
                            '<small class="text-muted" $AUTO_BAND_SELECTED_VISIBILITY$>'+
                            (device.wifi_last_band ?
                              'Banda escolhida em auto: ' + device.wifi_last_band :
                              ''
                            )+
                            '</small>'+
                          '</div>'+
                        '</div>'+
                      '</div>'+
                      '<div class="md-form">'+
                        '<div class="input-group">'+
                          '<div class="md-selectfield form-control my-0">'+
                            '<label class="active">Modo de operação</label>'+
                            '<select class="browser-default md-select" id="edit_wifi_mode-'+index+'" '+
                            '$REPLACE_WIFI_BAND_EN>'+
                              '<option value="11n" $REPLACE_SELECTED_MODE_11n$>BGN</option>'+
                              '<option value="11g" $REPLACE_SELECTED_MODE_11g$>G</option>'+
                            '</select>'+
                          '</div>'+
                        '</div>'+
                      '</div>'+
                      '$REPLACE_WIFI2_POWER'+
                    '</div>'+
                  '</div>'+
                  wifi5Pane+
                '</div>'+
              '</div>'+
            '</ul>';
          let wifi2Hidden = '<div class="custom-control custom-checkbox">'+
            '<input class="custom-control-input" type="checkbox" id="edit_wifi_hidden-'+index+'" '+
            '$REPLACE_SELECTED_WIFI_HIDDEN $REPLACE_WIFI_HIDDEN_EN></input>'+
            '<label class="custom-control-label" for="edit_wifi_hidden-'+index+'">'+
            'Ocultar SSID 2.4GHz'+
            '</label>'+
          '</div>';
          let wifi2Power = '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="active">Potência do sinal</label>'+
                '<select class="browser-default md-select" id="edit_wifi_power-'+index+'" '+
                '$REPLACE_WIFI_POWER_EN>'+
                  '<option value="100" $REPLACE_SELECTED_POWER_100$>100%</option>'+
                  '<option value="75"  $REPLACE_SELECTED_POWER_75$>75%</option>'+
                  '<option value="50"  $REPLACE_SELECTED_POWER_50$>50%</option>'+
                  '<option value="25"  $REPLACE_SELECTED_POWER_25$>25%</option>'+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>';
          let wifi5Hidden = '<div class="custom-control custom-checkbox">'+
            '<input class="custom-control-input" type="checkbox" id="edit_wifi5_hidden-'+index+'" '+
            '$REPLACE_SELECTED_WIFI5_HIDDEN $REPLACE_WIFI5_HIDDEN_EN></input>'+
            '<label class="custom-control-label" for="edit_wifi5_hidden-'+index+'">'+
            'Ocultar SSID 5.0GHz'+
            '</label>'+
          '</div>';
          let wifi5Power = '<div class="md-form">'+
            '<div class="input-group">'+
              '<div class="md-selectfield form-control my-0">'+
                '<label class="active">Potência do sinal</label>'+
                '<select class="browser-default md-select" id="edit_wifi5_power-'+index+'" '+
                '$REPLACE_WIFI5_POWER_EN>'+
                  '<option value="100" $REPLACE_SELECTED_POWER5_100$>100%</option>'+
                  '<option value="75"  $REPLACE_SELECTED_POWER5_75$>75%</option>'+
                  '<option value="50"  $REPLACE_SELECTED_POWER5_50$>50%</option>'+
                  '<option value="25"  $REPLACE_SELECTED_POWER5_25$>25%</option>'+
                '</select>'+
              '</div>'+
            '</div>'+
          '</div>';
          if (!isTR069) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI2_HIDDEN', wifi2Hidden);
            wifiTab = wifiTab.replace('$REPLACE_WIFI2_POWER', wifi2Power);
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_HIDDEN', wifi5Hidden);
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_POWER', wifi5Power);
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI2_HIDDEN', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI2_POWER', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_HIDDEN', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_POWER', '');
          }
          if (!isSuperuser && grantWifiInfo <= 1) {
            wifiTab = wifiTab.replace(/\$REPLACE_WIFI_EN/g, 'disabled');
            wifiTab = wifiTab.replace(/\$REPLACE_WIFI5_EN/g, 'disabled');
          } else {
            wifiTab = wifiTab.replace(/\$REPLACE_WIFI_EN/g, '');
            wifiTab = wifiTab.replace(/\$REPLACE_WIFI5_EN/g, '');
          }
          if (!grantWifiBand || (!isSuperuser && grantWifiInfo <= 1)) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_BAND_EN', 'disabled');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_BAND_EN', 'disabled');
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_BAND_EN', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_BAND_EN', '');
          }
          if (!grantWifiState || (!isSuperuser && grantWifiInfo <= 1)) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_STATE_EN', 'disabled');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_STATE_EN', 'disabled');
            wifiTab = wifiTab.replace('$REPLACE_SSID_PREFIX_ENABLED_EN', 'disabled');
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_STATE_EN', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_STATE_EN', '');
            wifiTab = wifiTab.replace('$REPLACE_SSID_PREFIX_ENABLED_EN', '');
          }
          if (!grantWifiPowerHiddenIpv6Box ||
             (!isSuperuser && grantWifiInfo <= 1)) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_HIDDEN_EN', 'disabled');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_HIDDEN_EN', 'disabled');
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_HIDDEN_EN', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_HIDDEN_EN', '');
          }
          if (!grantWifiPowerHiddenIpv6Box ||
             (!isSuperuser && grantWifiInfo <= 1)) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_POWER_EN', 'disabled');
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_POWER_EN', '');
          }
          if (!grantWifiPowerHiddenIpv6Box ||
             (!isSuperuser && grantWifiInfo <= 1) ||
             (device.wifi_channel_5ghz == 'auto')) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_POWER_EN', 'disabled');
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_POWER_EN', '');
          }
          if (isSuperuser || grantPassShow) {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_PASS', passwordToggle);
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_PASS', passwordToggle);
          } else {
            wifiTab = wifiTab.replace('$REPLACE_WIFI_PASS', '');
            wifiTab = wifiTab.replace('$REPLACE_WIFI5_PASS', '');
          }

          selectTarget = '$REPLACE_SELECTED_CHANNEL_' + device.wifi_channel;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_CHANNEL_.*?\$/g, '');
          // Show text about selected channel if in auto mode
          if (device.wifi_channel === 'auto') {
            wifiTab = wifiTab.replace('$AUTO_CHANNEL_SELECTED_VISIBILITY',
                                      '');
          } else {
            wifiTab = wifiTab.replace('$AUTO_CHANNEL_SELECTED_VISIBILITY',
                                      'style="display:none;"');
          }

          selectTarget = '$REPLACE_SELECTED_BAND_' + device.wifi_band;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_BAND_.*?\$/g, '');
          // Show text about selected band if in auto mode
          if (device.wifi_band === 'auto') {
            wifiTab = wifiTab.replace('$AUTO_BAND_SELECTED_VISIBILITY',
                                      '');
          } else {
            wifiTab = wifiTab.replace('$AUTO_BAND_SELECTED_VISIBILITY',
                                      'style="display:none;"');
          }

          selectTarget = '$REPLACE_SELECTED_MODE_' + device.wifi_mode;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_MODE_.*?\$/g, '');

          selectTarget = '$REPLACE_SELECTED_POWER_' + device.wifi_power;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_POWER_.*?\$/g, '');

          let currWifiState = (parseInt(device.wifi_state) == 1 ? 'checked' : '');
          wifiTab = wifiTab.replace('$REPLACE_SELECTED_WIFI_STATE', currWifiState);

          let currWifiHidden = (parseInt(device.wifi_hidden) == 1 ? 'checked' : '');
          wifiTab = wifiTab.replace('$REPLACE_SELECTED_WIFI_HIDDEN', currWifiHidden);

          selectTarget = '$REPLACE_SELECTED_CHANNEL5_' + device.wifi_channel_5ghz;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_CHANNEL5_.*?\$/g, '');
          // Show text about selected channel if in auto mode
          if (device.wifi_channel_5ghz === 'auto') {
            wifiTab = wifiTab.replace('$AUTO_CHANNEL_SELECTED_VISIBILITY5',
                                        '');
          } else {
            wifiTab = wifiTab.replace('$AUTO_CHANNEL_SELECTED_VISIBILITY5',
                                        'style="display:none;"');
          }

          let band = (device.wifi_band_5ghz === 'HT20' || device.wifi_band_5ghz === 'HT40')
                      ? ('V'+device.wifi_band_5ghz) : device.wifi_band_5ghz;
          selectTarget = '$REPLACE_SELECTED_BAND5_' + band;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_BAND5_.*?\$/g, '');
          // Show text about selected channel if in auto mode
          if (device.wifi_band_5ghz === 'auto') {
            wifiTab = wifiTab.replace('$AUTO_BAND_SELECTED_VISIBILITY5',
                                        '');
          } else {
            wifiTab = wifiTab.replace('$AUTO_BAND_SELECTED_VISIBILITY5',
                                        'style="display:none;"');
          }

          selectTarget = '$REPLACE_SELECTED_MODE5_' + device.wifi_mode_5ghz;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_MODE5_.*?\$/g, '');

          selectTarget = '$REPLACE_SELECTED_POWER5_' + device.wifi_power_5ghz;
          wifiTab = wifiTab.replace(selectTarget, 'selected="selected"');
          wifiTab = wifiTab.replace(/\$REPLACE_SELECTED_POWER5_.*?\$/g, '');

          let currWifiState5ghz = (parseInt(device.wifi_state_5ghz) == 1 ? 'checked' : '');
          wifiTab = wifiTab.replace('$REPLACE_SELECTED_WIFI5_STATE', currWifiState5ghz);

          let currWifiHidden5ghz = (parseInt(device.wifi_hidden_5ghz) == 1 ? 'checked' : '');
          wifiTab = wifiTab.replace('$REPLACE_SELECTED_WIFI5_HIDDEN', currWifiHidden5ghz);

          let currSsidPrefixEnabled = (device.isSsidPrefixEnabled) ? 'checked': '';
          wifiTab = wifiTab.replace('$REPLACE_SSID_PREFIX_ENABLED', currSsidPrefixEnabled);

          let baseEdit = '<label class="btn btn-primary tab-switch-btn" '+
          'data-tab-id="#tab_$REPLACE_TAB_TYPE-'+index+'">'+
            '$REPLACE_TAB_NAME<input type="radio"></input>'+
          '</label>';

          let lanEdit = baseEdit
          .replace('$REPLACE_TAB_TYPE', 'lan')
          .replace('$REPLACE_TAB_NAME', 'LAN');

          let modeEdit = baseEdit
          .replace('$REPLACE_TAB_TYPE', 'opmode')
          .replace('$REPLACE_TAB_NAME', 'Modo');

          let wifiEdit = baseEdit
          .replace('$REPLACE_TAB_TYPE', 'wifi')
          .replace('$REPLACE_TAB_NAME', 'Wi-Fi');

          let removeDevice = '<div class="col-2 text-right">'+
            buildRemoveDevice()+
          '</div>';

          let formRow = '<tr class="d-none" $REPLACE_ATTRIBUTES>'+
            '<td class="grey lighten-5" colspan="12">'+
              '<form class="edit-form needs-validation" novalidate="true">'+
                '<div class="row">'+
                  '<div class="col-10 actions-opts">'+
                    '<div class="btn-group btn-group-toggle" data-toggle="buttons">'+
                      '<label class="btn btn-primary tab-switch-btn active ml-0" '+
                      'data-tab-id="#tab_about-'+index+'">'+
                        'Sobre<input type="radio"></input>'+
                      '</label>'+
                      '$REPLACE_MODE_EDIT'+
                      '<label class="btn btn-primary tab-switch-btn" '+
                      'data-tab-id="#tab_wan-'+index+'">'+
                        'WAN<input type="radio"></input>'+
                      '</label>'+
                      '$REPLACE_LAN_EDIT'+
                      '$REPLACE_WIFI_EDIT'+
                      '$REPLACE_ACTIONS'+
                    '</div>'+
                    '<br>'+
                    '<span class="badge badge-success bounceIn d-none">Sucesso</span>'+
                    '<span class="badge badge-warning bounceIn d-none">Falha</span>'+
                    '<br>'+
                  '</div>'+
                  '$REPLACE_DEVICE_REMOVE'+
                '</div>'+
                '<div class="row">'+
                  '<div class="col">'+
                    aboutTab+
                    opmodeTab+
                    wanTab+
                    lanTab+
                    wifiTab+
                  '</div>'+
                '</div>'+
                '$REPLACE_EDIT_BUTTON'+
              '</form>'+
            '</td>'+
          '</tr>';
          formRow = formRow.replace('$REPLACE_ATTRIBUTES', formAttr);
          if (grantLanEdit) {
            formRow = formRow.replace('$REPLACE_LAN_EDIT', lanEdit);
          } else {
            formRow = formRow.replace('$REPLACE_LAN_EDIT', '');
          }
          if (!isTR069 && grantOpmode) {
            formRow = formRow.replace('$REPLACE_MODE_EDIT', modeEdit);
          } else {
            formRow = formRow.replace('$REPLACE_MODE_EDIT', '');
          }
          if (isSuperuser || grantWifiInfo >= 1) {
            formRow = formRow.replace('$REPLACE_WIFI_EDIT', wifiEdit);
          } else {
            formRow = formRow.replace('$REPLACE_WIFI_EDIT', '');
          }
          if (isSuperuser || grantDeviceActions) {
            formRow = formRow.replace('$REPLACE_ACTIONS', devActions);
          } else {
            formRow = formRow.replace('$REPLACE_ACTIONS', '');
          }
          if ((!isSuperuser && !grantDeviceRemoval) ||
              (device.mesh_slaves && device.mesh_slaves.length > 0)) {
            formRow = formRow.replace('$REPLACE_DEVICE_REMOVE', '');
          } else {
            formRow = formRow.replace('$REPLACE_DEVICE_REMOVE', removeDevice);
          }
          if (!device.mesh_slaves || device.mesh_slaves.length === 0) {
            let editButtonRow = buildFormSubmit();
            formRow = formRow.replace('$REPLACE_EDIT_BUTTON', editButtonRow);
          } else {
            formRow = formRow.replace('$REPLACE_EDIT_BUTTON', '');
          }

          finalHtml += formRow;

          if (device.mesh_slaves && device.mesh_slaves.length > 0) {
            let slaveIdx = 0;
            device.mesh_slaves.forEach((slave)=>{
              let slaveDev = res.devices.find((d)=>d._id===slave);
              let rowAttr = buildRowData(slaveDev, index);
              let statusClasses = buildStatusClasses(slaveDev);
              let statusAttributes = buildStatusAttributes(slaveDev);
              let notifications = buildNotification();
              let removeButton = '<td>'+buildRemoveDevice(true)+'</td>';
              let infoRow = buildTableRowInfo(slaveDev, false, true, index);
              infoRow = infoRow.replace('$REPLACE_ATTRIBUTES', rowAttr);
              infoRow = infoRow.replace('$REPLACE_COLOR_CLASS', statusClasses);
              infoRow = infoRow.replace('$REPLACE_COLOR_ATTR', statusAttributes);
              infoRow = infoRow.replace('$REPLACE_UPGRADE', removeButton);
              infoRow = infoRow.replace('$REPLACE_COLOR_CLASS_PILL', 'lighten-2');
              infoRow = infoRow.replace('$REPLACE_PILL_TEXT', 'Flashbox');
              if (isSuperuser || grantNotificationPopups) {
                infoRow = infoRow.replace('$REPLACE_NOTIFICATIONS', notifications);
              } else {
                infoRow = infoRow.replace('$REPLACE_NOTIFICATIONS', '');
              }
              finalHtml += infoRow;

              let formRow = '<tr class="d-none grey lighten-5 slave-form-'+index+'"><td colspan="12">'+
                buildAboutTab(slaveDev, index, false,
                              grantWifiExtendedChannels, slaveIdx)+
              '</td></tr>';
              if (!isSuperuser && !grantDeviceId) {
                formRow = formRow.replace(/\$REPLACE_EN_ID/g, 'disabled');
              } else {
                formRow = formRow.replace(/\$REPLACE_EN_ID/g, '');
              }
              finalHtml += formRow;
              if (slaveDev.external_reference &&
                  slaveDev.external_reference.kind === 'CPF') {
                $('#edit_external_reference-' + index + '-' + slaveIdx)
                .mask('000.000.000-009').keyup();
              } else if (slaveDev.external_reference &&
                         slaveDev.external_reference.kind === 'CNPJ') {
                $('#edit_external_reference-' + index + '-' + slaveIdx)
                .mask('00.000.000/0000-00').keyup();
              }
              slaveIdx++;
            });
            let editButtonRow = buildFormSubmit(true);
            let editButtonAttr = ' data-slave-count="'+device.mesh_slaves.length+'"';
            let editTableRow = '<tr class="d-none slave-'+index+'"'+editButtonAttr+'>'+
              '<td class="grey lighten-5" colspan="12">'+
                editButtonRow+
              '</td>'+
            '</tr>';
            finalHtml += editTableRow;
          }

          // Index variable has a global scope related to below functions
          let localIdx = index;
          $(document).on('change', '#edit_connect_type-' + localIdx,
          (event) => {
            $('#edit_connect_type_warning-' + localIdx).removeClass('d-none');
            if ($('#edit_connect_type-' + localIdx).val() === 'PPPoE') {
              $('#edit_pppoe_combo-' + localIdx).removeClass('d-none');
            } else {
              $('#edit_pppoe_combo-' + localIdx).addClass('d-none');
            }
          });
          $(document).on('change', '#edit_opmode-' + localIdx, (event)=>{
            if ($('#edit_opmode-' + localIdx).val() === 'Modo Roteador') {
              $('#edit_opmode_checkboxes-' + localIdx).hide();
              $('#edit_opmode_ip_combo-' + localIdx).hide();
              $('#edit_opmode_alert-' + localIdx).hide();
              $('#edit_opmode_alert_ip-' + localIdx).hide();
              $('#edit_opmode_fixip_en-' + localIdx)[0].checked = false;
              $('#edit_opmode_switch_en-' + localIdx)[0].checked = false; // Changed to false because the text in the label changed to a positive logic (Enable instead Disable)
            } else if ($('#edit_opmode-' + localIdx).val() === 'Modo Bridge') {
              $('#edit_opmode_checkboxes-' + localIdx).show();
              $('#edit_opmode_alert-' + localIdx).show();
            }
          });
          $(document).on('change', '#edit_opmode_fixip_en-' + localIdx, (event)=>{
            if ($('input[name="edit_opmode_fixip_en-'+localIdx+'"]:checked').length > 0) {
              $('#edit_opmode_alert_ip-' + localIdx).show();
              $('#edit_opmode_ip_combo-' + localIdx).show();
            } else {
              $('#edit_opmode_alert_ip-' + localIdx).hide();
              $('#edit_opmode_ip_combo-' + localIdx).hide();
            }
          });

          // Apply mask on reference input
          if (device.external_reference &&
              device.external_reference.kind === 'CPF') {
            $('#edit_external_reference-' + index)
            .mask('000.000.000-009').keyup();
          } else if (device.external_reference &&
                     device.external_reference.kind === 'CNPJ') {
            $('#edit_external_reference-' + index)
            .mask('00.000.000/0000-00').keyup();
          }

          index += 1;
        }
        // Attach elements back to DOM after manipulation
        deviceTableContent.html(finalHtml);
        // Hide filtered columns
        applyVisibleColumns();
        // Fill table pagination
        deviceTablePagination.append(
          $('<ul>').addClass('pagination pagination-lg').append(() => {
            let opts = $('<div>');
            let delta = 2;
            let currPage = res.page;
            for (let idx = 1; idx <= res.pages; idx += 1) {
              if (idx == 1 || idx == res.pages ||
                  ((idx >= currPage - delta) && (idx <= currPage + delta))
              ) {
                if (idx == currPage) {
                  opts.append(
                    $('<li>').addClass('page-item active').append(
                      $('<a>')
                      .addClass('page-link primary-color')
                      .attr('id', 'curr-page-link')
                      .html(idx),
                    ),
                  );
                } else {
                  if (idx == res.pages &&
                      (currPage + delta <= res.pages - delta)
                  ) {
                    opts.append(
                      $('<li>').addClass('page-item').append(
                        $('<h3>').addClass('page-link disabled').html('...'),
                      ),
                    );
                  }
                  opts.append(
                    $('<li>').addClass('page-item').append(
                      $('<a>').addClass('page-link change-page-link')
                      .html(idx),
                    ),
                  );
                  if (idx == 1 && (currPage - delta > delta)) {
                    opts.append(
                      $('<li>').addClass('page-item').append(
                        $('<h3>').addClass('page-link disabled').html('...'),
                      ),
                    );
                  }
                }
              }
            }
            return opts.html();
          }),
        );
        // Apply IP mask on LAN subnet field
        deviceTableContent.find('.ip-mask-field').mask('099.099.099.099');
        // Fetch existing notifications
        $.ajax({
          url: '/notification/fetch',
          type: 'POST',
          traditional: true,
          data: {
            targets: res.devices.map((device) => device._id),
          },
          success: function(res) {
            for (let idx = 0; idx < res.notifications.length; idx += 1) {
              let notification = res.notifications[idx];
              changeDeviceStatusOnTable(deviceTableContent,
                                        notification.target, notification);
            }
            // Enable device status notification reception
            $.ajax({
              url: '/notification/register/devicestatus',
              type: 'POST',
              dataType: 'json',
              error: function(xhr, status, error) {
                displayAlertMsg(JSON.parse(xhr.responseText));
              },
            });
          },
          error: function(xhr, status, error) {
            displayAlertMsg(JSON.parse(xhr.responseText));
          },
          complete: function() {
            // Attach elements back to DOM after manipulation
            $('#devices-table').append(deviceTableContent);
          },
        });
        // Important: include and initialize socket.io first using socket var
        // Actions when a status change is received
        socket.on('DEVICESTATUS', function(macaddr, data) {
          changeDeviceStatusOnTable(deviceTableContent, macaddr, data);
        });
        // Important: include and initialize socket.io first using socket var
        socket.on('UPSTATUS', function(macaddr, data) {
          let row = $('[id="' + macaddr + '"]');
          if (data.sysuptime) {
            row.find('.device-sys-up-time')
            .removeClass('grey-text pending-update')
            .html(
              secondsTimeSpanToHMS(parseInt(data.sysuptime)),
            );
          }
          if (data.wanuptime) {
            row.find('.device-wan-up-time')
            .removeClass('grey-text pending-update')
            .html(
              secondsTimeSpanToHMS(parseInt(data.wanuptime)),
            );
          }
        });
        // Important: include and initialize socket.io first using socket var
        socket.on('UPSTATUSTR069', function(macaddr, data) {
          let row = $('[id="' + macaddr + '"]');
          if (data.sysuptime) {
            row.find('.device-sys-up-time')
            .removeClass('grey-text pending-update')
            .html(
              secondsTimeSpanToHMS(parseInt(data.sysuptime)),
            );
          }
          if (data.wanuptime) {
            row.find('.device-wan-up-time')
            .removeClass('grey-text pending-update')
            .html(
              secondsTimeSpanToHMS(parseInt(data.wanuptime)),
            );
          }
        });
      },
    });
  };
  // Initial table
  if (window.location.href.indexOf('devicelist') !== -1) {
    loadDevicesTable();
  }

  $(document).on('submit', '#devices-search-form', function(event) {
    let filterList = $('#devices-search-input').val();
    filterList += ',' + columnToSort + ',' + columnSortType;
    loadDevicesTable(1, filterList);
    return false;
  });

  $(document).on('click', '.change-page-link', function(event) {
    let pageNum = parseInt($(event.target).html());
    let filterList = $('#devices-search-input').val();
    filterList += ',' + columnToSort + ',' + columnSortType;
    loadDevicesTable(pageNum, filterList);
  });

  $(document).on('click', '.btn-trash', function(event) {
    let row = $(event.target).parents('tr');
    let id = row.data('deviceid');
    swal({
      type: 'warning',
      title: 'Atenção!',
      text: 'Tem certeza que deseja remover esse cadastro?',
      confirmButtonText: 'OK',
      confirmButtonColor: '#4db6ac',
      cancelButtonText: 'Cancelar',
      cancelButtonColor: '#f2ab63',
      showCancelButton: true,
    }).then((result)=>{
      if (result.value) {
        $.ajax({
          url: '/devicelist/delete',
          type: 'post',
          traditional: true,
          data: {ids: [id]},
          success: function(res) {
            let pageNum = parseInt($('#curr-page-link').html());
            let filterList = $('#devices-search-input').val();
            filterList += ',' + columnToSort + ',' + columnSortType;
            loadDevicesTable(pageNum, filterList);
            swal({
              type: res.type,
              title: res.message,
              confirmButtonColor: '#4db6ac',
              confirmButtonText: 'OK',
            });
          },
        });
      }
    });
  });

  $(document).on('click', '#btn-trash-multiple', function(event) {
    swal({
      type: 'warning',
      title: 'Atenção!',
      text: 'Tem certeza que deseja remover esses cadastros?',
      confirmButtonText: 'OK',
      confirmButtonColor: '#4db6ac',
      cancelButtonText: 'Cancelar',
      cancelButtonColor: '#f2ab63',
      showCancelButton: true,
    }).then((result)=>{
      if (result.value) {
        $.ajax({
          type: 'POST',
          url: '/devicelist/delete',
          traditional: true,
          data: {ids: selectedDevices},
          success: function(res) {
            $('#btn-trash-multiple').addClass('disabled');
            let pageNum = parseInt($('#curr-page-link').html());
            let filterList = $('#devices-search-input').val();
            filterList += ',' + columnToSort + ',' + columnSortType;
            loadDevicesTable(pageNum, filterList);
            swal({
              type: res.type,
              title: res.message,
              confirmButtonColor: '#4db6ac',
              confirmButtonText: 'OK',
            });
          },
        });
      }
    });
  });

  $(document).on('click', '.btn-factory', function(event) {
    let row = $(event.target).parents('tr');
    let id = row.data('deviceid');
    let deviceModel = row.data('device-model');
    let deviceVersion = row.data('device-version');
    let abort = false;
    let abortMsg = '';
    // Special cases
    if (deviceModel !== '') {
      // Factory firmware issue caused by TP-Link partition change
      if (deviceModel === 'ARCHERC6V2US' &&
          parseInt(deviceVersion.split('.')[1]) < 28) {
        abort = true;
        abortMsg = 'Não é possível retornar para a firmware de fábrica a ' +
                 'partir da versão instalada do Flashbox. Atualize primeiro ' +
                 'o Flashbox para a versão 0.28.0 ou superior e em seguida ' +
                 'faça o retorno para a firmware de fábrica.';
      }
    }
    swal({
      type: 'warning',
      title: 'Atenção!',
      text: 'Este CPE perderá todas as configurações. Esta ação só poderá '+
      'ser desfeita com uma nova instalação através do Assistente Flashbox.',
      confirmButtonText: 'OK',
      confirmButtonColor: '#4db6ac',
      cancelButtonText: 'Cancelar',
      cancelButtonColor: '#f2ab63',
      showCancelButton: true,
    }).then((result)=>{
      if (abort) {
        swal({
          type: 'warning',
          title: 'Atenção!',
          text: abortMsg,
          confirmButtonColor: '#4db6ac',
          confirmButtonText: 'OK',
        });
      } else if (result.value) {
        swal({
          title: 'Preparando firmware de fábrica...',
          onOpen: () => {
            swal.showLoading();
          },
        });
        $.ajax({
          url: '/devicelist/factoryreset/' + id,
          type: 'post',
          success: function(res) {
            let pageNum = parseInt($('#curr-page-link').html());
            let filterList = $('#devices-search-input').val();
            filterList += ',' + columnToSort + ',' + columnSortType;
            loadDevicesTable(pageNum, filterList);
            swal.close();
            swal({
              type: 'success',
              title: 'Processo iniciado com sucesso',
              text: 'Aguarde o CPE reiniciar, e então segure o botão de '+
                    'reset por 15 segundos.',
              confirmButtonColor: '#4db6ac',
              confirmButtonText: 'OK',
            });
          },
          error: function(err) {
            swal.close();
            swal({
              type: 'error',
              title: 'Um erro ocorreu',
              text: 'Não foi possível restaurar o CPE para o firmware de '+
                    'fábrica. Por favor tente novamente.',
              confirmButtonColor: '#4db6ac',
              confirmButtonText: 'OK',
            });
          },
        });
      }
    });
  });

  $(document).on('click', '[id^=devices-column-]',
  function(event) {
    let columnId = event.target.id;
    let columnNumber = columnId.split('-')[2];
    let statusHCol = $('table#devices-table th:nth-child(' + columnNumber +')');
    if (statusHCol.is(':visible')) {
      changeDevicesColumnVisibility('invisible', columnNumber);
      visibleColumnsOnPage.splice(
        visibleColumnsOnPage.indexOf(parseInt(columnNumber)), 1);
    } else {
      changeDevicesColumnVisibility('visible', columnNumber);
      visibleColumnsOnPage.push(parseInt(columnNumber));
    }
  });

  $(document).on('click', '.dropdown-menu.dont-close', function(event) {
    // Avoid closing the dropdown menu when clicking inside
    event.stopPropagation();
  });

  $(document).on('click', '#online-status-sum', function(event) {
    $('.tags-input input').focus().val('online').blur();
    loadDevicesTable(1, 'online');
  });
  $(document).on('click', '#recovery-status-sum', function(event) {
    $('.tags-input input').focus().val('instavel').blur();
    loadDevicesTable(1, 'instavel');
  });
  $(document).on('click', '#offline-status-sum', function(event) {
    $('.tags-input input').focus().val('offline').blur();
    loadDevicesTable(1, 'offline');
  });
  // Table column sorts
  $(document).on('click', '[id^=sort-]', function(event) {
    let pageNum = parseInt($('#curr-page-link').html());
    let filterList = $('#devices-search-input').val();
    // Reset other columns
    $('[id^=sort-]').css('font-weight', '').each(function(index) {
      let headerText = $(this).text().split('\u2191')[0];
      headerText = headerText.split('\u2193')[0];
      $(this).text(headerText);
    });
    // Set column sort visual
    $(event.target).css('font-weight', 'Bold');
    // Set sort tags
    columnToSort = '/' + this.id;
    if (columnSortType === '/sort-type-asc') {
      $(event.target).append('\u2193');
      columnSortType = '/sort-type-desc';
    } else {
      $(event.target).append('\u2191');
      columnSortType = '/sort-type-asc';
    }
    filterList += ',' + columnToSort + ',' + columnSortType;
    loadDevicesTable(pageNum, filterList);
  });

  $(document).on('change', '[id^=edit_is_ssid_prefix_enabled-]',
  function(input) {
    let cssClass1;
    let cssClass2;
    cssClass1 = input.target.parentNode.parentNode.
      childNodes[2].childNodes[0].childNodes[0].
      childNodes[1].childNodes[1].classList;
    if (!input.target.parentNode.parentNode.
      childNodes[2].childNodes[1] == false) {
      cssClass2 = input.target.parentNode.parentNode.
        childNodes[2].childNodes[1].childNodes[0].
        childNodes[1].childNodes[1].classList;
    }
    if (input.target.checked) {
      cssClass1.remove('d-none');
      if (!cssClass2 == false) {
        cssClass2.remove('d-none');
      }
    } else {
      cssClass1.add('d-none');
      if (!cssClass2 == false) {
        cssClass2.add('d-none');
      }
    }
  });
});
