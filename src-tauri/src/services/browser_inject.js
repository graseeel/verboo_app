(function installVerbooBrowser(nativeTransport) {
  if (window.__verbooBrowser) {
    window.__verbooBrowser.announce();
    return;
  }

  if (!nativeTransport || typeof nativeTransport.post !== 'function') return;
  try { delete globalThis.__VERBOO_NATIVE_TRANSPORT__; } catch (_) {}

  function start() {
    if (window.__verbooBrowser) return;

    var copy = {
      pencilTitle: 'Why did you mark this?',
      arrowTitle: 'Type your suggestion',
      pencilPlaceholder: 'Describe what should change',
      arrowPlaceholder: 'Describe what should change',
      cancel: 'Cancel',
      add: 'Add annotation'
    };
    var mode = 'idle';
    var activeToken = null;
    var activeRect = null;
    var activeDocumentRect = null;
    var activeKind = null;
    var selectedElement = null;
    var drawing = false;
    var points = [];
    var sendQueue = [];
    var flushTimer = 0;
    var presenceTimer = 0;

    var host = document.createElement('div');
    var layerDocument = document;
    host.setAttribute('data-verboo-browser-layer', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    function attachHost() {
      var parent = layerDocument.documentElement || layerDocument.body;
      if (parent && !host.isConnected) parent.appendChild(host);
    }
    attachHost();
    var hostObserver = new MutationObserver(attachHost);
    hostObserver.observe(layerDocument, { childList: true, subtree: true });
    var root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = [
      '<style>',
      ':host{all:initial;color-scheme:dark}',
      '*{box-sizing:border-box}',
      '#ink,#picker,#presence{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}',
      '#ink.active,#picker.active{pointer-events:auto}',
      '#ink.active{cursor:crosshair;touch-action:none}',
      '#picker.active{cursor:pointer}',
      '#presence{overflow:hidden;opacity:0;transition:opacity 120ms ease-out}',
      '#presence.visible{opacity:1}',
      '#presence-cursor{position:absolute;left:0;top:0;width:18px;height:22px;filter:drop-shadow(0 4px 7px rgba(0,0,0,.35));will-change:transform}',
      '#presence-cursor:before{content:"";display:block;width:0;height:0;border-top:18px solid #8b5cf6;border-right:12px solid transparent;transform:rotate(-13deg);transform-origin:top left}',
      '#presence-pulse{position:absolute;left:0;top:0;border:2px solid #8b5cf6;border-radius:10px;background:rgba(139,92,246,.09);opacity:0;will-change:transform,opacity}',
      '#presence-pulse.pulse{animation:verboo-pulse 620ms cubic-bezier(.22,1,.36,1)}',
      '@keyframes verboo-pulse{0%{opacity:.9;transform:scale(.84)}55%{opacity:.55}100%{opacity:0;transform:scale(1.13)}}',
      '#outline{position:fixed;display:none;border:2px solid #8b5cf6;border-radius:7px;background:rgba(139,92,246,.10);box-shadow:0 0 0 1px rgba(255,255,255,.34),0 8px 28px rgba(15,10,35,.22);pointer-events:none}',
      '#label{position:fixed;display:none;max-width:260px;padding:5px 8px;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:#171524;color:#f6f3ff;font:600 11px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.32);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
      '#modal{position:fixed;inset:0;pointer-events:none;visibility:hidden;transition:visibility 130ms step-end}',
      '#modal.open{pointer-events:auto;visibility:visible;transition:visibility 0ms}',
      '#card{position:absolute;width:min(320px,calc(100vw - 28px));padding:14px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:#171725;color:#f7f4ff;box-shadow:0 8px 8px rgba(0,0,0,.34);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;transform:translateY(var(--entry-y,6px)) scale(.97);transform-origin:var(--origin-x,50%) var(--origin-y,0%);transition:transform 180ms cubic-bezier(.22,1,.36,1),opacity 130ms cubic-bezier(.22,1,.36,1);will-change:transform,opacity}',
      '#card:before{content:"";position:absolute;left:var(--anchor-x,50%);width:10px;height:10px;background:#171725;transform:translateX(-50%) rotate(45deg);pointer-events:none}',
      '#card[data-placement="below"]:before{top:-6px;border-top:1px solid rgba(255,255,255,.14);border-left:1px solid rgba(255,255,255,.14)}',
      '#card[data-placement="above"]:before{bottom:-6px;border-right:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14)}',
      '#modal.open #card{opacity:1;transform:translateY(0) scale(1)}',
      '#title{margin:0 0 8px;font-size:13px;font-weight:680;letter-spacing:-.01em}',
      '#note{display:block;width:100%;min-height:64px;resize:none;padding:9px 10px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:#0f101a;color:#f7f4ff;font:13px/1.45 inherit;outline:none}',
      '#note:focus{border-color:rgba(139,92,246,.85);box-shadow:0 0 0 3px rgba(139,92,246,.16)}',
      '#note::placeholder{color:#858398}',
      '#actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}',
      'button{height:30px;padding:0 11px;border:1px solid rgba(255,255,255,.13);border-radius:7px;background:transparent;color:#cbc8d8;font:600 12px inherit;cursor:pointer;transition:transform 120ms cubic-bezier(.22,1,.36,1),background-color 120ms ease-out,color 120ms ease-out}',
      'button:active{transform:scale(.97)}',
      '#submit{border-color:rgba(139,92,246,.65);background:#7c4ee8;color:white}',
      '@media(hover:hover) and (pointer:fine){button:hover{background:rgba(255,255,255,.06);color:#fff}#submit:hover{background:#895cf0}}',
      '@media(prefers-reduced-motion:reduce){#outline,#presence,button{transition:none}#modal,#modal.open{transition:visibility 80ms step-end}#card,#modal.open #card{transform:none;transition:opacity 80ms ease-out}button:active{transform:none}#presence-pulse.pulse{animation:none;opacity:.48;transform:none}}',
      '</style>',
      '<canvas id="ink"></canvas>',
      '<div id="picker"><div id="outline"></div><div id="label"></div></div>',
      '<div id="presence"><div id="presence-pulse"></div><div id="presence-cursor"></div></div>',
      '<div id="modal" aria-hidden="true"><section id="card" role="dialog" aria-labelledby="title">',
      '<h2 id="title"></h2><textarea id="note" rows="3"></textarea>',
      '<div id="actions"><button id="cancel" type="button"></button><button id="submit" type="button"></button></div>',
      '</section></div>'
    ].join('');

    var canvas = root.getElementById('ink');
    var picker = root.getElementById('picker');
    var outline = root.getElementById('outline');
    var label = root.getElementById('label');
    var modal = root.getElementById('modal');
    var card = root.getElementById('card');
    var presence = root.getElementById('presence');
    var presenceCursor = root.getElementById('presence-cursor');
    var presencePulse = root.getElementById('presence-pulse');
    var note = root.getElementById('note');
    var title = root.getElementById('title');
    var cancel = root.getElementById('cancel');
    var submit = root.getElementById('submit');
    var context = canvas.getContext('2d');

    function resizeCanvas() {
      var ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(innerWidth * ratio));
      canvas.height = Math.max(1, Math.round(innerHeight * ratio));
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      if (context) context.setTransform(ratio, 0, 0, ratio, 0, 0);
      redrawInk();
      if (activeRect && modal.classList.contains('open')) positionNoteCard(activeRect);
    }

    function flushMessages() {
      if (!sendQueue.length) return;
      try {
        while (sendQueue.length) nativeTransport.post(sendQueue.shift());
        clearTimeout(flushTimer);
        flushTimer = 0;
      } catch (_) {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushMessages, 120);
      }
    }

    function post(message) {
      sendQueue.push(JSON.stringify({
        tabId: nativeTransport.tabId,
        bridgeToken: nativeTransport.bridgeToken,
        documentToken: nativeTransport.documentToken,
        payload: JSON.stringify(message),
      }));
      flushMessages();
    }

    function announce() {
      post({
        type: 'page-ready',
        url: location.href,
        title: document.title,
        historyLength: history.length,
        viewport: { width: innerWidth, height: innerHeight }
      });
    }

    function announceLoaded() {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          post({ type: 'page-loaded', url: location.href });
        });
      });
    }

    function clearInk() {
      if (context) context.clearRect(0, 0, innerWidth, innerHeight);
      points = [];
    }

    function setMode(next) {
      mode = next === 'pencil' || next === 'arrow' ? next : 'idle';
      canvas.classList.toggle('active', mode === 'pencil');
      picker.classList.toggle('active', mode === 'arrow');
      if (mode !== 'arrow' && !activeToken) hidePicker();
      if (mode !== 'pencil' && !activeToken) clearInk();
    }

    function drawSegment(previous, point) {
      if (!context) return;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#8b5cf6';
      context.lineWidth = 4;
      context.shadowColor = 'rgba(255,255,255,.55)';
      context.shadowBlur = 1;
      context.beginPath();
      context.moveTo(previous.x - scrollX, previous.y - scrollY);
      context.lineTo(point.x - scrollX, point.y - scrollY);
      context.stroke();
      context.shadowBlur = 0;
    }

    function redrawInk() {
      if (!context) return;
      context.clearRect(0, 0, innerWidth, innerHeight);
      for (var index = 1; index < points.length; index += 1) {
        drawSegment(points[index - 1], points[index]);
      }
    }

    function pointFromEvent(event) {
      return { x: event.clientX + scrollX, y: event.clientY + scrollY };
    }

    function beginDrawing(event) {
      if (mode !== 'pencil' || event.button !== 0 || activeToken || !event.isTrusted) return;
      drawing = true;
      clearInk();
      points.push(pointFromEvent(event));
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    }

    function moveDrawing(event) {
      if (!drawing) return;
      var point = pointFromEvent(event);
      points.push(point);
      drawSegment(points[points.length - 2], point);
      if (points.length >= 8192) endDrawing(event);
      event.preventDefault();
    }

    function endDrawing(event) {
      if (!drawing) return;
      drawing = false;
      if (points.length < 2) { clearInk(); return; }
      var xs = points.map(function (point) { return point.x; });
      var ys = points.map(function (point) { return point.y; });
      var padding = 14;
      var left = Math.max(0, Math.min.apply(Math, xs) - scrollX - padding);
      var top = Math.max(0, Math.min.apply(Math, ys) - scrollY - padding);
      var right = Math.min(innerWidth, Math.max.apply(Math, xs) - scrollX + padding);
      var bottom = Math.min(innerHeight, Math.max.apply(Math, ys) - scrollY + padding);
      if (right <= left || bottom <= top) { clearInk(); return; }
      createCandidate({
        kind: 'pen',
        rect: { x: left, y: top, width: right - left, height: bottom - top }
      });
      event.preventDefault();
    }

    function underlyingElement(event) {
      picker.style.pointerEvents = 'none';
      var element = document.elementFromPoint(event.clientX, event.clientY);
      picker.style.pointerEvents = '';
      if (!element || element === host || host.contains(element)) return null;
      return element;
    }

    function cssSelector(element) {
      if (element.id) return '#' + CSS.escape(element.id);
      var parts = [];
      var current = element;
      while (current && current.nodeType === 1 && parts.length < 4) {
        var part = current.tagName.toLowerCase();
        if (current.classList && current.classList.length) {
          part += '.' + Array.prototype.slice.call(current.classList, 0, 2).map(CSS.escape).join('.');
        } else if (current.parentElement) {
          var siblings = Array.prototype.filter.call(current.parentElement.children, function (child) { return child.tagName === current.tagName; });
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        if (current.id) break;
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    function componentName(element) {
      var key = Object.keys(element).find(function (name) { return name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0; });
      var fiber = key ? element[key] : null;
      while (fiber) {
        var type = fiber.type;
        var name = type && (type.displayName || type.name);
        if (name && name !== 'Fragment') return name;
        fiber = fiber.return;
      }
      var declared = element.getAttribute('data-component') || element.getAttribute('data-component-name');
      if (declared) return declared;
      var role = element.getAttribute('role');
      if (role) return role.split(/\s+/).filter(Boolean).map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }).join('');
      var categories = {
        a: 'Link', button: 'Button', form: 'Form', img: 'Image', input: 'Input',
        nav: 'Navigation', select: 'Select', textarea: 'TextArea', table: 'Table',
        dialog: 'Dialog', header: 'Header', footer: 'Footer', main: 'MainContent',
        h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading'
      };
      return categories[element.tagName.toLowerCase()] || (element.tagName.indexOf('-') >= 0 ? element.tagName.toLowerCase() : 'Element');
    }

    function elementLabel(element) {
      return componentName(element) || element.getAttribute('aria-label') || element.tagName.toLowerCase() + ' · ' + cssSelector(element);
    }

    function showPicker(element) {
      var rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return hidePicker();
      outline.style.display = 'block';
      outline.style.left = Math.max(0, rect.left) + 'px';
      outline.style.top = Math.max(0, rect.top) + 'px';
      outline.style.width = Math.min(innerWidth - Math.max(0, rect.left), rect.width) + 'px';
      outline.style.height = Math.min(innerHeight - Math.max(0, rect.top), rect.height) + 'px';
      label.textContent = elementLabel(element);
      label.style.display = 'block';
      label.style.left = Math.max(8, Math.min(innerWidth - 268, rect.left)) + 'px';
      label.style.top = Math.max(8, rect.top - 30) + 'px';
      selectedElement = element;
    }

    function hidePicker() {
      outline.style.display = 'none';
      label.style.display = 'none';
      selectedElement = null;
    }

    function movePicker(event) {
      if (mode !== 'arrow' || activeToken) return;
      var element = underlyingElement(event);
      if (element && element !== selectedElement) showPicker(element);
    }

    function pickElement(event) {
      if (mode !== 'arrow' || activeToken || event.button !== 0 || !event.isTrusted) return;
      var element = underlyingElement(event) || selectedElement;
      if (!element) return;
      showPicker(element);
      var rect = element.getBoundingClientRect();
      createCandidate({
        kind: 'element',
        selector: cssSelector(element),
        component: componentName(element),
        rect: {
          x: Math.max(0, rect.left - 6),
          y: Math.max(0, rect.top - 6),
          width: Math.min(innerWidth - Math.max(0, rect.left - 6), rect.width + 12),
          height: Math.min(innerHeight - Math.max(0, rect.top - 6), rect.height + 12)
        }
      });
      event.preventDefault();
      event.stopPropagation();
    }

    function createCandidate(candidate) {
      activeToken = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      activeRect = candidate.rect;
      activeDocumentRect = {
        x: candidate.rect.x + scrollX,
        y: candidate.rect.y + scrollY,
        width: candidate.rect.width,
        height: candidate.rect.height
      };
      activeKind = candidate.kind;
      setMode('idle');
      post(Object.assign({}, candidate, {
        type: 'annotation-candidate',
        token: activeToken,
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight }
      }));
    }

    function updateCopy() {
      var isElement = activeKind === 'element';
      title.textContent = isElement ? copy.arrowTitle : copy.pencilTitle;
      note.placeholder = isElement ? copy.arrowPlaceholder : copy.pencilPlaceholder;
      cancel.textContent = copy.cancel;
      submit.textContent = copy.add;
    }

    function restoreCandidate(candidate) {
      if (!candidate || !candidate.token || !candidate.rect) return;
      activeToken = candidate.token;
      activeRect = candidate.rect;
      activeDocumentRect = {
        x: candidate.rect.x + scrollX,
        y: candidate.rect.y + scrollY,
        width: candidate.rect.width,
        height: candidate.rect.height
      };
      activeKind = candidate.kind;
      setMode('idle');
      outline.style.display = 'block';
      outline.style.left = activeRect.x + 'px';
      outline.style.top = activeRect.y + 'px';
      outline.style.width = activeRect.width + 'px';
      outline.style.height = activeRect.height + 'px';
    }

    function positionNoteCard(rect) {
      if (!rect) return;
      var margin = 14;
      var gap = 10;
      var cardWidth = Math.min(320, innerWidth - margin * 2);
      card.style.width = cardWidth + 'px';
      var cardHeight = card.offsetHeight || 156;
      var centeredLeft = rect.x + rect.width / 2 - cardWidth / 2;
      var left = Math.max(margin, Math.min(innerWidth - cardWidth - margin, centeredLeft));
      var below = rect.y + rect.height + gap;
      var above = rect.y - cardHeight - gap;
      var placeBelow = below + cardHeight <= innerHeight - margin || above < margin;
      var anchoredTop = placeBelow ? below : above;
      var top = Math.max(margin, Math.min(innerHeight - cardHeight - margin, anchoredTop));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      var anchorX = Math.max(22, Math.min(cardWidth - 22, rect.x + rect.width / 2 - left));
      card.setAttribute('data-placement', placeBelow ? 'below' : 'above');
      card.style.setProperty('--anchor-x', anchorX + 'px');
      card.style.setProperty('--origin-x', anchorX + 'px');
      card.style.setProperty('--origin-y', placeBelow ? '0%' : '100%');
      card.style.setProperty('--entry-y', placeBelow ? '-6px' : '6px');
    }

    function openNoteModal(token) {
      if (!activeToken || token !== activeToken) return;
      updateCopy();
      note.value = '';
      positionNoteCard(activeRect);
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(function () { note.focus(); });
    }

    function dismiss(submitAnnotation) {
      if (!activeToken) return;
      var token = activeToken;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      if (submitAnnotation) {
        post({ type: 'annotation-submit', token: token, note: note.value.trim() || null });
      } else {
        post({ type: 'annotation-cancel', token: token });
        complete(token);
      }
    }

    function complete(token) {
      if (token && activeToken !== token) return;
      activeToken = null;
      activeRect = null;
      activeDocumentRect = null;
      activeKind = null;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      clearInk();
      hidePicker();
    }

    function showPresence(rect) {
      if (!rect) return;
      clearTimeout(presenceTimer);
      var width = Math.max(18, Math.min(innerWidth, rect.width || 18));
      var height = Math.max(18, Math.min(innerHeight, rect.height || 18));
      var left = Math.max(0, Math.min(innerWidth - width, rect.x || 0));
      var top = Math.max(0, Math.min(innerHeight - height, rect.y || 0));
      var targetX = left + width / 2;
      var targetY = top + height / 2;
      presencePulse.style.left = left + 'px';
      presencePulse.style.top = top + 'px';
      presencePulse.style.width = width + 'px';
      presencePulse.style.height = height + 'px';
      presencePulse.classList.remove('pulse');
      presenceCursor.style.transition = 'none';
      presence.classList.add('visible');
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion) {
        presenceCursor.style.transform = 'translate3d(' + targetX + 'px,' + targetY + 'px,0)';
        presencePulse.classList.add('pulse');
        presenceTimer = setTimeout(function () {
          presence.classList.remove('visible');
          presencePulse.classList.remove('pulse');
        }, 700);
        return;
      }
      presenceCursor.style.transform = 'translate3d(' + (innerWidth + 24) + 'px,' + Math.max(8, targetY - 90) + 'px,0)';
      requestAnimationFrame(function () {
        presenceCursor.style.transition = 'transform 280ms cubic-bezier(.22,1,.36,1)';
        presenceCursor.style.transform = 'translate3d(' + targetX + 'px,' + targetY + 'px,0)';
        requestAnimationFrame(function () { presencePulse.classList.add('pulse'); });
      });
      presenceTimer = setTimeout(function () {
        presence.classList.remove('visible');
        presencePulse.classList.remove('pulse');
      }, 950);
    }

    canvas.addEventListener('pointerdown', beginDrawing, true);
    canvas.addEventListener('pointermove', moveDrawing, true);
    canvas.addEventListener('pointerup', endDrawing, true);
    canvas.addEventListener('pointercancel', endDrawing, true);
    picker.addEventListener('pointermove', movePicker, true);
    picker.addEventListener('pointerdown', pickElement, true);
    cancel.addEventListener('click', function () { dismiss(false); });
    submit.addEventListener('click', function () { dismiss(true); });
    modal.addEventListener('pointerdown', function (event) { if (event.target === modal) dismiss(false); });
    note.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); dismiss(false); }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); dismiss(true); }
    });
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('scroll', function () {
      redrawInk();
      if (activeDocumentRect) {
        activeRect = {
          x: activeDocumentRect.x - scrollX,
          y: activeDocumentRect.y - scrollY,
          width: activeDocumentRect.width,
          height: activeDocumentRect.height
        };
        if (outline.style.display === 'block') {
          outline.style.left = activeRect.x + 'px';
          outline.style.top = activeRect.y + 'px';
        }
        if (modal.classList.contains('open')) positionNoteCard(activeRect);
      }
    }, { passive: true });
    window.addEventListener('load', announceLoaded);
    window.addEventListener('pageshow', function () { announce(); announceLoaded(); });
    window.addEventListener('popstate', announce);
    window.addEventListener('hashchange', announce);
    resizeCanvas();
    updateCopy();

    window.__verbooBrowser = {
      ping: function () { return 'pong:' + location.href; },
      announce: announce,
      setMode: setMode,
      setCopy: function (next) { copy = Object.assign(copy, next || {}); updateCopy(); },
      openNoteModal: openNoteModal,
      restoreCandidate: restoreCandidate,
      complete: complete,
      showPresence: showPresence
    };
    announce();
    if (document.readyState === 'complete') announceLoaded();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})(globalThis.__VERBOO_NATIVE_TRANSPORT__);
