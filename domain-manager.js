const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const logger = require('./logger');

const DOMAINS_FILE = path.join(__dirname, 'domains.json');
const ENV_FILE = path.join(__dirname, '.env');

// Хостер API configuration
const HOSTER_API_TOKEN = process.env.HOSTER_API_TOKEN || process.env.NETLIFY_API_TOKEN || '';
const HOSTER_API_URL = 'https://api.netlify.com/api/v1';

class DomainManager {
  constructor() {
    this.domains = this.loadDomains();
    this.serverIP = process.env.SERVER_IP || '';
    this.lastSyncTime = null;
  }

  loadDomains() {
    try {
      if (fs.existsSync(DOMAINS_FILE)) {
        const data = fs.readFileSync(DOMAINS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.error('[DomainManager] Error loading domains:', error);
    }
    return { domains: [], currentDomain: '', lastSync: null };
  }

  saveDomains() {
    try {
      this.domains.lastSync = new Date().toISOString();
      fs.writeFileSync(DOMAINS_FILE, JSON.stringify(this.domains, null, 2));
      return true;
    } catch (error) {
      logger.error('[DomainManager] Error saving domains:', error);
      return false;
    }
  }

  /**
   * Получить список DNS зон из хостера
   */
  async getDNSZones() {
    return new Promise((resolve, reject) => {
      if (!HOSTER_API_TOKEN) {
        reject(new Error('HOSTER_API_TOKEN not configured'));
        return;
      }

      const req = https.request({
        hostname: 'api.netlify.com',
        path: '/api/v1/dns_zones',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${HOSTER_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const zones = JSON.parse(data);
              logger.info(`[DomainManager] Fetched ${zones.length} DNS zones from хостер`);
              resolve(zones);
            } else {
              reject(new Error(`Хостер API error: ${res.statusCode} - ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }

  /**
   * Синхронизировать домены с хостером
   */
  async syncWithHoster(force = false) {
    try {
      logger.info('[DomainManager] Starting sync with хостер...');
      
      const hosterZones = await this.getDNSZones();
      
      const hosterDomainsMap = new Map();
      hosterZones.forEach(zone => {
        hosterDomainsMap.set(zone.name, {
          zoneId: zone.id,
          name: zone.name,
          supportedRecords: zone.supported_record_types || []
        });
      });

      // Обновить существующие домены
      this.domains.domains.forEach(domain => {
        const hosterZone = hosterDomainsMap.get(domain.domain);
        if (hosterZone) {
          if (domain.hosterZoneId !== hosterZone.zoneId) {
            logger.info(`[DomainManager] Updated Zone ID for ${domain.domain}: ${hosterZone.zoneId}`);
            domain.hosterZoneId = hosterZone.zoneId;
          }
          hosterDomainsMap.delete(domain.domain);
        } else {
          if (domain.status !== 'active') {
            domain.status = 'unavailable';
            logger.warn(`[DomainManager] Domain ${domain.domain} not found in хостер`);
          }
        }
      });

      // Добавить новые домены из хостера
      hosterDomainsMap.forEach((zone, domainName) => {
        const exists = this.domains.domains.find(d => d.domain === domainName);
        if (!exists) {
          logger.info(`[DomainManager] Adding new domain from хостер: ${domainName}`);
          this.domains.domains.push({
            domain: domainName,
            status: 'available',
            hosterZoneId: zone.zoneId,
            hosterSiteId: null,
            dnsRecordId: null,
            createdAt: new Date().toISOString(),
            syncedAt: new Date().toISOString()
          });
        }
      });

      this.saveDomains();
      this.lastSyncTime = new Date();
      
      logger.info(`[DomainManager] Sync completed. Total domains: ${this.domains.domains.length}`);
      return {
        success: true,
        total: this.domains.domains.length,
        synced: hosterZones.length,
        added: hosterDomainsMap.size
      };
    } catch (error) {
      logger.error('[DomainManager] Error syncing with хостер:', error);
      throw error;
    }
  }

  /**
   * Получить доступные домены
   */
  getAvailableDomains() {
    return this.domains.domains.filter(d => 
      d.status === 'available' && d.hosterZoneId
    );
  }

  /**
   * Получить текущий активный домен
   */
  getCurrentDomain() {
    return this.domains.currentDomain;
  }

  /**
   * Получить все домены
   */
  getAllDomains() {
    return this.domains.domains;
  }

  /**
   * Получить информацию о домене
   */
  getDomainInfo(domainName) {
    return this.domains.domains.find(d => d.domain === domainName);
  }

  /**
   * Получить DNS записи для домена
   */
  async getDNSRecords(zoneId) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.netlify.com',
        path: `/api/v1/dns_zones/${zoneId}/dns_records`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${HOSTER_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Хостер API error: ${res.statusCode} - ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Добавить A-запись
   */
  async addARecord(zoneId, domain, ip) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        type: 'A',
        hostname: '@',
        value: ip,
        ttl: 3600
      });

      const req = https.request({
        hostname: 'api.netlify.com',
        path: `/api/v1/dns_zones/${zoneId}/dns_records`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HOSTER_API_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200 || res.statusCode === 201) {
              const result = JSON.parse(responseData);
              logger.info(`[DomainManager] A-record added for ${domain}: ${ip}`);
              resolve(result);
            } else {
              reject(new Error(`Хостер API error: ${res.statusCode} - ${responseData}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Удалить A-запись
   */
  async deleteARecord(zoneId, recordId) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.netlify.com',
        path: `/api/v1/dns_zones/${zoneId}/dns_records/${recordId}`,
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${HOSTER_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            logger.info(`[DomainManager] A-record deleted: ${recordId}`);
            resolve(true);
          } else {
            reject(new Error(`Хостер API error: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Удалить все A-записи для домена
   */
  async removeAllARecords(zoneId, keepRecordIds = []) {
    try {
      const records = await this.getDNSRecords(zoneId);
      const aRecords = records.filter(r => r.type === 'A' && r.hostname === '@');
      
      for (const record of aRecords) {
        if (!keepRecordIds.includes(record.id)) {
          await this.deleteARecord(zoneId, record.id);
          logger.info(`[DomainManager] Removed old A-record: ${record.id}`);
        }
      }
    } catch (error) {
      logger.error('[DomainManager] Error removing A-records:', error);
      throw error;
    }
  }

  /**
   * Получить SSL сертификат через certbot
   */
  async obtainSSLCertificate(domain) {
    try {
      logger.info(`[DomainManager] Obtaining SSL certificate for ${domain}...`);
      
      const email = process.env.SSL_EMAIL || 'admin@example.com';
      const nginxConfPath = `/etc/nginx/sites-available/${domain}`;
      
      // Проверяем, существует ли конфиг nginx
      if (!fs.existsSync(nginxConfPath)) {
        logger.warn(`[DomainManager] Nginx config not found: ${nginxConfPath}`);
        return false;
      }

      // Получаем сертификат
      try {
        execSync(
          `certbot --nginx -d ${domain} -d www.${domain} --non-interactive --agree-tos --email ${email} --redirect`,
          { stdio: 'inherit', timeout: 120000 }
        );
        logger.info(`[DomainManager] SSL certificate obtained for ${domain}`);
        return true;
      } catch (error) {
        logger.error(`[DomainManager] Error obtaining SSL certificate: ${error.message}`);
        // Пробуем без www
        try {
          execSync(
            `certbot --nginx -d ${domain} --non-interactive --agree-tos --email ${email} --redirect`,
            { stdio: 'inherit', timeout: 120000 }
          );
          logger.info(`[DomainManager] SSL certificate obtained for ${domain} (without www)`);
          return true;
        } catch (error2) {
          logger.error(`[DomainManager] Error obtaining SSL certificate (retry): ${error2.message}`);
          return false;
        }
      }
    } catch (error) {
      logger.error('[DomainManager] Error in obtainSSLCertificate:', error);
      return false;
    }
  }

  /**
   * Создать/обновить nginx конфиг для домена
   */
  async updateNginxConfig(newDomain) {
    try {
      const nginxConfPath = `/etc/nginx/sites-available/${newDomain}`;
      const nginxEnabledPath = `/etc/nginx/sites-enabled/${newDomain}`;
      
      // Если конфиг не существует, создаем его
      if (!fs.existsSync(nginxConfPath)) {
        logger.info(`[DomainManager] Creating nginx config for ${newDomain}...`);
        
        const template = `server {
    listen 80;
    listen [::]:80;
    server_name ${newDomain} www.${newDomain};

    access_log /var/log/nginx/${newDomain}-access.log;
    error_log /var/log/nginx/${newDomain}-error.log;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    location /health {
        access_log off;
        return 200 "healthy\\n";
        add_header Content-Type text/plain;
    }
}`;

        fs.writeFileSync(nginxConfPath, template);
        
        // Создаем симлинк
        if (!fs.existsSync(nginxEnabledPath)) {
          execSync(`ln -sf ${nginxConfPath} ${nginxEnabledPath}`);
        }
        
        logger.info(`[DomainManager] Created nginx config for ${newDomain}`);
      } else {
        // Обновляем существующий конфиг
        let nginxContent = fs.readFileSync(nginxConfPath, 'utf8');
        const oldDomain = this.domains.currentDomain;
        
        if (oldDomain) {
          nginxContent = nginxContent.replace(
            new RegExp(oldDomain.replace(/\./g, '\\.'), 'g'),
            newDomain
          );
          nginxContent = nginxContent.replace(
            new RegExp(`www\\.${oldDomain.replace(/\./g, '\\.')}`, 'g'),
            `www.${newDomain}`
          );
        }
        
        // Обновляем server_name если нужно
        if (!nginxContent.includes(`server_name ${newDomain}`)) {
          nginxContent = nginxContent.replace(
            /server_name\s+[^;]+;/,
            `server_name ${newDomain} www.${newDomain};`
          );
        }
        
        fs.writeFileSync(nginxConfPath, nginxContent);
        logger.info(`[DomainManager] Updated nginx config for ${newDomain}`);
      }

      // Проверяем конфиг и перезагружаем nginx
      execSync('nginx -t', { stdio: 'pipe' });
      execSync('systemctl reload nginx', { stdio: 'inherit' });
      logger.info(`[DomainManager] Nginx reloaded for ${newDomain}`);
      
      return true;
    } catch (error) {
      logger.error('[DomainManager] Error updating nginx config:', error);
      throw error;
    }
  }

  /**
   * Переключить домен
   */
  async switchDomain(newDomain) {
    const domain = this.domains.domains.find(d => d.domain === newDomain);
    if (!domain) {
      throw new Error(`Domain ${newDomain} not found. Run sync first.`);
    }

    if (!domain.hosterZoneId) {
      throw new Error(`Zone ID not found for ${newDomain}. Run sync first.`);
    }

    if (domain.status === 'unavailable') {
      throw new Error(`Domain ${newDomain} is unavailable in хостер`);
    }

    if (!this.serverIP) {
      throw new Error('SERVER_IP not configured in .env');
    }

    if (!HOSTER_API_TOKEN) {
      throw new Error('HOSTER_API_TOKEN not configured in .env');
    }

    try {
      const oldDomain = this.domains.domains.find(d => d.status === 'active');
      
      // 1. Удалить A-запись у старого домена
      if (oldDomain && oldDomain.hosterZoneId && oldDomain.dnsRecordId) {
        try {
          await this.removeAllARecords(oldDomain.hosterZoneId);
          logger.info(`[DomainManager] Removed A-records from old domain: ${oldDomain.domain}`);
        } catch (error) {
          logger.warn(`[DomainManager] Could not remove A-records from old domain: ${error.message}`);
        }
      }

      // 2. Обновить nginx конфиг
      await this.updateNginxConfig(newDomain);

      // 3. Получить SSL сертификат
      const sslObtained = await this.obtainSSLCertificate(newDomain);
      if (!sslObtained) {
        logger.warn(`[DomainManager] SSL certificate not obtained, but continuing...`);
      }

      // 4. Добавить A-запись для нового домена
      await this.removeAllARecords(domain.hosterZoneId);
      const newRecord = await this.addARecord(domain.hosterZoneId, newDomain, this.serverIP);
      domain.dnsRecordId = newRecord.id;

      // 5. Update .env
      this.updateEnvFile(newDomain);

      // 6. Update domains.json
      if (oldDomain) {
        oldDomain.status = 'available';
        oldDomain.dnsRecordId = null;
      }
      domain.status = 'active';
      domain.dnsRecordId = newRecord.id;
      domain.lastSwitched = new Date().toISOString();
      this.domains.currentDomain = newDomain;
      this.saveDomains();

      // 7. Restart server
      await this.restartServer();

      logger.info(`[DomainManager] Successfully switched to domain: ${newDomain}`);
      return { 
        success: true, 
        domain: newDomain,
        dnsRecordId: newRecord.id,
        ip: this.serverIP,
        sslObtained: sslObtained
      };
    } catch (error) {
      logger.error('[DomainManager] Error switching domain:', error);
      throw error;
    }
  }

  updateEnvFile(newDomain) {
    try {
      let envContent = '';
      if (fs.existsSync(ENV_FILE)) {
        envContent = fs.readFileSync(ENV_FILE, 'utf8');
      }

      if (envContent.includes('CUSTOM_DOMAIN=')) {
        envContent = envContent.replace(
          /CUSTOM_DOMAIN=.*/,
          `CUSTOM_DOMAIN=${newDomain}`
        );
      } else {
        envContent += `\nCUSTOM_DOMAIN=${newDomain}\n`;
      }

      fs.writeFileSync(ENV_FILE, envContent);
      logger.info(`[DomainManager] Updated .env file with domain: ${newDomain}`);
    } catch (error) {
      logger.error('[DomainManager] Error updating .env file:', error);
      throw error;
    }
  }

  async restartServer() {
    try {
      try {
        execSync('pm2 list', { stdio: 'pipe' });
        execSync('pm2 restart reverse-proxy || pm2 restart all', { stdio: 'inherit' });
        logger.info('[DomainManager] Server restarted via PM2');
      } catch (pm2Error) {
        try {
          execSync('systemctl restart reverse-proxy', { stdio: 'inherit' });
          logger.info('[DomainManager] Server restarted via systemd');
        } catch (systemdError) {
          logger.warn('[DomainManager] Could not restart server automatically');
        }
      }
    } catch (error) {
      logger.error('[DomainManager] Error restarting server:', error);
      throw error;
    }
  }
}

module.exports = new DomainManager();
