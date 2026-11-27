// VISIÓN · una sola entrada para el equipo: se escribe la clave una vez y el menú
// muestra lo que cada quien puede usar. La clave vive solo mientras la pestaña está abierta.
(function(){
  var get = function(k){ try { return sessionStorage.getItem(k) || ''; } catch(e){ return ''; } };
  var set = function(k, v){ try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch(e){} };
  var role = function(){ return get('vision.admin') ? 'admin' : get('vision.staff') ? 'staff' : ''; };
  var here = location.pathname.indexOf('/vision/admin') === 0 ? 'admin' : location.pathname.indexOf('/vision/entregas') === 0 ? 'scan' : 'night';

  var css = document.createElement('style');
  css.textContent = '#out,#logout{display:none !important}body{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px)) !important}.toast{bottom:calc(88px + env(safe-area-inset-bottom,0px)) !important}' +
    '.vnav{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;justify-content:center;gap:6px;padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));background:rgba(10,10,10,.96);border-top:1px solid #2c2c2c}' +
    '.vnav a,.vnav button{flex:1;max-width:170px;text-align:center;font:700 14px "DM Sans",system-ui,sans-serif;color:#A9A69C;background:none;border:0;border-radius:12px;padding:13px 6px;text-decoration:none;cursor:pointer}' +
    '.vnav a[aria-current=page]{background:#C8B273;color:#0A0A0A}.vnav .in{color:#C8B273;border:1px solid rgba(200,178,115,.5)}' +
    '.vlog{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;padding:18px}' +
    '.vlog form{width:100%;max-width:380px;background:#141414;border:1px solid #3a3a3a;border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:12px;color:#EDE9DE;font:400 15px/1.45 "DM Sans",system-ui,sans-serif}' +
    '.vlog h2{font:italic 400 28px/1.15 "Playfair Display",serif;color:#C8B273;margin:0}.vlog p{margin:0;color:#A9A69C}' +
    '.vlog label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#A9A69C}.vlog input{background:#0A0A0A;color:#fff;border:1px solid #3a3a3a;border-radius:10px;padding:13px;font-size:17px}' +
    '.vlog button{font:700 15px "DM Sans",system-ui,sans-serif;border-radius:10px;padding:14px;cursor:pointer;border:1px solid #3a3a3a;background:none;color:#C8B273}.vlog button[type=submit]{background:#C8B273;border-color:#C8B273;color:#0A0A0A}.vlog .err{color:#ff9d93;min-height:1.2em;text-align:center}';
  document.head.appendChild(css);

  var nav = document.createElement('nav');
  nav.className = 'vnav'; nav.setAttribute('aria-label', 'Secciones del equipo');
  document.body.appendChild(nav);

  function link(href, label, id){ return '<a href="' + href + '"' + (here === id ? ' aria-current="page"' : '') + '>' + label + '</a>'; }
  var drawn = null;
  function draw(){
    var r = role(); if (r === drawn) return; drawn = r;
    nav.innerHTML = link('/vision/equipo/', 'La noche', 'night') + (r ? link('/vision/entregas/', 'Escanear', 'scan') : '') +
      (r === 'admin' ? link('/vision/admin/', 'Panel', 'admin') : '') +
      '<button type="button" class="' + (r ? '' : 'in') + '">' + (r ? 'Salir' : 'Entrar') + '</button>';
    document.querySelectorAll('[data-team]').forEach(function(el){ el.style.display = r ? '' : 'none'; });
  }

  function ask(){
    var box = document.createElement('div'); box.className = 'vlog';
    box.innerHTML = '<form><h2>Equipo Visión</h2><p>Escribe tu clave. La aplicación muestra lo que te corresponde.</p>' +
      '<label>Clave<input type="password" name="key" required maxlength="100" autocomplete="current-password"></label>' +
      '<label>Tu nombre<input name="who" required maxlength="40" autocomplete="given-name"></label>' +
      '<div class="err" role="alert"></div><button type="submit">Entrar</button><button type="button">Cancelar</button></form>';
    document.body.appendChild(box);
    var f = box.querySelector('form'), err = box.querySelector('.err');
    try { f.who.value = localStorage.getItem('vision.who') || ''; } catch(e){}
    box.querySelector('button[type=button]').addEventListener('click', function(){ box.remove(); });
    f.addEventListener('submit', function(e){
      e.preventDefault(); err.textContent = '';
      var key = f.key.value.trim(), who = f.who.value.trim();
      var done = function(admin){
        set('vision.admin', admin ? key : ''); set('vision.staff', key);
        try { localStorage.setItem('vision.who', who); } catch(x){}
        box.remove(); draw();
        if (here !== 'night') location.reload(); else location.href = admin ? '/vision/admin/' : '/vision/entregas/';
      };
      var check = function(path, header, value){ var h = {}; h[header] = value; return fetch('/api/vision' + path, {headers: h, cache: 'no-store'}); };
      // La clave del panel solo admite caracteres simples en la cabecera.
      var asAdmin = /^[\x20-\x7e]+$/.test(key) ? check('/admin/overview', 'x-admin-key', key) : Promise.resolve({ok: false});
      asAdmin.then(function(r){
        if (r.ok) return done(true);
        return check('/staff/check', 'x-staff-key', encodeURIComponent(key)).then(function(s){
          if (s.ok) return done(false);
          return s.json().then(function(j){ err.textContent = j.message || 'Clave incorrecta.'; });
        });
      }).catch(function(){ err.textContent = 'Sin conexión. Intenta de nuevo.'; });
    });
    f.key.focus();
  }

  nav.addEventListener('click', function(e){
    if (!e.target.closest('button')) return;
    if (!role()) return ask();
    set('vision.admin', ''); set('vision.staff', ''); location.href = '/vision/equipo/';
  });
  draw();
  setInterval(draw, 1000); // las pantallas con su propio ingreso actualizan el menú
})();
