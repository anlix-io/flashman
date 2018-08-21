
$(document).ready(function() {
  let selectedItens = [];
  let selectedNames = [];

  $('#card-header').click(function() {
    let plus = $(this).find('.fa-plus');
    let cross = $(this).find('.fa-times');
    plus.removeClass('fa-plus').addClass('fa-times');
    cross.removeClass('fa-times').addClass('fa-plus');
  });

  $('#btn-roles-trash').click(function(event) {
    $.ajax({
      type: 'POST',
      url: '/user/role/del',
      traditional: true,
      data: {ids: selectedItens, names: selectedNames},
      success: function(res) {
        if (res.type == 'success') {
          displayAlertMsg(res);
          setTimeout(function() {
            window.location.reload();
          }, 1000);
        } else {
          displayAlertMsg(res);
        }
      },
    });
  });

  $(document).on('change', '.checkbox', function(event) {
    let itemId = $(this).prop('id');
    let itemName = $(this).data('name');
    if (itemId == 'checkall') {
      $('.checkbox').not(this).prop('checked', this.checked).change();
    } else {
      let itemIdx = selectedItens.indexOf(itemId);
      if ($(this).is(':checked')) {
        if (itemIdx == -1) {
          selectedItens.push(itemId);
          selectedNames.push(itemName);
        }
      } else {
        if (itemIdx != -1) {
          selectedItens.splice(itemIdx, 1);
          selectedNames.splice(itemIdx, 1);
        }
      }
    }
  });

  // Handle new roles
  $('#new-role-form').submit(function(event) {
    if ($(this)[0].checkValidity()) {
      $.post($(this).attr('action'), $(this).serialize(), function(res) {
        displayAlertMsg(res);
        if (res.type == 'success') {
          setTimeout(function() {
            window.location.reload();
          }, 2000);
        }
      }, 'json');
    } else {
      event.preventDefault();
      event.stopPropagation();
    }
    $(this).addClass('was-validated');
    return false;
  });

  $.get('/user/role/get/all', function(res) {
    if (res.type == 'success') {
      $('#loading-roles').hide();
      $('#roles-table-wrapper').show();

      res.roles.forEach(function(roleObj) {
        $('#roles-table-content').append(
          $('<tr></tr>').append(
            $('<td></td>').addClass('col-xs-1').append(
              $('<input></input>').addClass('checkbox')
              .attr('type', 'checkbox')
              .attr('id', roleObj._id)
              .attr('data-name', roleObj.name)
            ),
            $('<td></td>').addClass('text-center').html(roleObj.name),
            $('<td></td>').addClass('text-center col-xs-1 colapse')
              .attr('style', 'cursor: pointer;').append(
                $('<div></div>').addClass('fas fa-chevron-down fa-lg colapse')
            )
          ),
          // form row
          $('<tr></tr>').attr('style', 'display: none;').append(
            $('<td></td>').addClass('grey lighten-5').attr('colspan', '3')
            .append(
              $('<form></form>').addClass('needs-validation')
              .attr('novalidate', 'true')
              .attr('action', '/user/role/edit/' + roleObj._id)
              .append(
                $('<div></div>').addClass('row')
                .attr('style', 'margin: 0px;')
                .append(
                  $('<div></div>').addClass('col-4').append(
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>').text('Informações do WiFi'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-wifi-info').append(
                        $('<option></option>').val(0).text('Não visualizar'),
                        $('<option></option>').val(1).text('Visualizar'),
                        $('<option></option>').val(2).text('Visualizar e editar')
                      )
                    ),
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>').text('Informações do PPPoE'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-pppoe-info').append(
                        $('<option></option>').val(0).text('Não visualizar'),
                        $('<option></option>').val(1).text('Visualizar'),
                        $('<option></option>').val(2).text('Visualizar e editar')
                      )
                    ),
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Controle de Atualização de Firmware'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-firmware-upgrade').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    )
                  ),
                  $('<div></div>').addClass('col-4').append(
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Controle do Tipo de Conexão'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-wan-type').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    ),
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Controle de Identificação do Dispositivo'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-device-id').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    ),
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Controle de Ações no Dispositivo'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-device-actions').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    )
                  ),
                  $('<div></div>').addClass('col-4').append(
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Remoção de Registro de Dispositivo'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-device-removal').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    ),
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Adição de Registro de Dispositivo'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'new-grant-device-add').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    ),
                    $('<div></div>').addClass('input-entry').append(
                      $('<label></label>')
                      .text('Controle de Gerência de Firmwares'),
                      $('<select></select>').addClass('form-control')
                      .attr('name', 'grant-firmware-manage').append(
                        $('<option></option>').val(0).text('Bloquear'),
                        $('<option></option>').val(1).text('Permitir')
                      )
                    )
                  )
                ),
                $('<div></div>').addClass('row')
                .addClass('mt-2')
                .attr('style', 'margin: 0px;')
                .append(
                  $('<div></div>').addClass('col text-center').append(
                    $('<div></div>').addClass('form-buttons').append(
                      $('<button></button>').addClass('btn teal lighten-2')
                      .attr('type', 'submit')
                      .append(
                        $('<div></div>').addClass('fas fa-check'),
                        $('<span></span>').html('&nbsp Editar')
                      )
                    )
                  )
                )
              )
            )
          )
        );
      });
    } else {
      displayAlertMsg({
        type: res.type,
        message: res.message,
      });
    }
  }, 'json');

  $(document).on('click', '.colapse', function(event) {
    let formRow = $(event.target).parents('tr').next();

    if ($(this).children().hasClass('fa-chevron-down')) {
      formRow.show();
      $(this).find('.fa-chevron-down')
        .removeClass('fa-chevron-down')
        .addClass('fa-chevron-up');
    } else if ($(this).children().hasClass('fa-chevron-up')) {
      formRow.hide();
      $(this).find('.fa-chevron-up')
        .removeClass('fa-chevron-up')
        .addClass('fa-chevron-down');
    }
  });
});
