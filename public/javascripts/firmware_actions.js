
$(document).on('change', ':file', function() {
  let input = $(this);
  let numFiles = input.get(0).files ? input.get(0).files.length : 1;
  let label = input.val().replace(/\\/g, '/').replace(/.*\//, '');

  input.trigger('fileselect', [numFiles, label]);
});

$(document).ready(function() {
  let selectedItens = [];

  $(':file').on('fileselect', function(event, numFiles, label) {
    let input = $(this).parents('.input-group').find(':text');

    if (input.length) {
      input.val(label);
    }
  });

  $('#btn-firmware-trash').click(function(event) {
    $.ajax({
      type: 'POST',
      url: '/firmware/del',
      traditional: true,
      data: {ids: selectedItens},
      success: function(res) {
        if (res.type == 'success') {
          setTimeout(function() {
            window.location.reload();
          }, 100);
        } else {
          $('#flash-banner .flash').addClass('alert-' + res.type);
          $('#flash-banner .flash').html(res.message);
          $('#flash-banner').show();
        }
      },
    });
  });

  $('.checkbox').change(function(event) {
    let itemId = $(this).prop('id');

    if (itemId == 'checkall') {
      $('.checkbox').not(this).prop('checked', this.checked).change();
    } else {
      let row = $(event.target).parents('tr');

      let itemIdx = selectedItens.indexOf(itemId);
      if ($(this).is(':checked')) {
        if (itemIdx == -1) {
          selectedItens.push(itemId);
        }
      } else {
        if (itemIdx != -1) {
          selectedItens.splice(itemIdx, 1);
        }
      }
    }
  });

  $('form[name=firmwareform]').submit(function() {
    if ($('input[name=firmwarefile]').val().trim()) {
      $.ajax({
        type: 'POST',
        enctype: 'multipart/form-data',
        url: $(this).attr('action'),
        data: new FormData($(this)[0]),
        processData: false,
        contentType: false,
        cache: false,
        timeout: 600000,
        success: function(res) {
          $('#flash-banner .flash').removeClass(function(index, className) {
              return (className.match(/(^|\s)alert-\S+/g) || []).join(' ');
          });
          $('#flash-banner .flash').addClass('alert-' + res.type);
          $('#flash-banner .flash').html(res.message);
          $('#flash-banner').show();
          if (res.type == 'success') {
            setTimeout(function() {
              window.location.reload();
            }, 2000);
          }
        },
      });
    } else {
      $('#flash-banner .flash').addClass('alert-danger');
      $('#flash-banner .flash').html('Nenhum arquivo foi selecionado');
      $('#flash-banner').show();
    }

    return false;
  });
});
