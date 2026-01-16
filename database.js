/**
 * Database Module - SQLite для хранения данных о посетителях
 * Автоматическая очистка данных старше 3 дней
 */

const Database = require('better-sqlite3');
const path = require('path');
const logger = require('./logger');

// Путь к базе данных
const DB_PATH = path.join(__dirname, 'visitors.db');

// Инициализация базы данных
let db;

function initDatabase() {
  // Если БД уже инициализирована, не инициализируем повторно
  if (db) {
    logger.info('[DB] Database already initialized');
    return;
  }
  
  try {
    db = new Database(DB_PATH);
    
    // Включить WAL режим для лучшей производительности
    db.pragma('journal_mode = WAL');
    
    // Создать таблицы
    createTables();
    
    // Запустить автоматическую очистку
    startAutoCleanup();
    
    logger.info('[DB] Database initialized successfully');
  } catch (error) {
    logger.error('[DB] Failed to initialize database:', error.message);
    throw error;
  }
}

function createTables() {
  // Таблица посетителей (основная информация)
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      user_agent TEXT,
      device_type TEXT, -- 'phone', 'desktop', 'tablet', 'unknown'
      browser TEXT,
      os TEXT,
      country TEXT,
      city TEXT,
      first_seen INTEGER NOT NULL, -- timestamp
      last_seen INTEGER NOT NULL, -- timestamp
      visit_count INTEGER DEFAULT 1,
      is_bot INTEGER DEFAULT 0,
      referer TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  // Таблица сессий (каждый визит = сессия)
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitor_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id INTEGER NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      page_count INTEGER DEFAULT 0,
      action_count INTEGER DEFAULT 0,
      last_page TEXT,
      telegram_message_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE
    )
  `);
  
  // Таблица действий (все действия пользователя)
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitor_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      visitor_id INTEGER NOT NULL,
      action_type TEXT NOT NULL, -- 'page_view', 'form_fill', 'button_click', 'navigation', etc.
      page_path TEXT,
      page_name TEXT,
      field_name TEXT,
      field_value TEXT,
      button_text TEXT,
      action_data TEXT, -- JSON с дополнительными данными
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (session_id) REFERENCES visitor_sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE
    )
  `);
  
  // Индексы для быстрого поиска
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip);
    CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen);
    CREATE INDEX IF NOT EXISTS idx_sessions_visitor_id ON visitor_sessions(visitor_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON visitor_sessions(start_time);
    CREATE INDEX IF NOT EXISTS idx_actions_session_id ON visitor_actions(session_id);
    CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON visitor_actions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_actions_visitor_id ON visitor_actions(visitor_id);
  `);
  
  logger.info('[DB] Tables created successfully');
}

/**
 * Получить или создать посетителя
 */
function getOrCreateVisitor(ip, userAgent, deviceInfo = {}) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  // Проверить существующего посетителя
  const existing = db.prepare('SELECT * FROM visitors WHERE ip = ?').get(ip);
  
  if (existing) {
    // Обновить информацию
    db.prepare(`
      UPDATE visitors 
      SET last_seen = ?, 
          visit_count = visit_count + 1,
          user_agent = ?,
          device_type = ?,
          browser = ?,
          os = ?
      WHERE ip = ?
    `).run(
      now,
      userAgent || existing.user_agent,
      deviceInfo.deviceType || existing.device_type,
      deviceInfo.browser || existing.browser,
      deviceInfo.os || existing.os,
      ip
    );
    
    return existing.id;
  } else {
    // Создать нового посетителя
    const result = db.prepare(`
      INSERT INTO visitors (ip, user_agent, device_type, browser, os, first_seen, last_seen, visit_count, is_bot)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      ip,
      userAgent || '',
      deviceInfo.deviceType || 'unknown',
      deviceInfo.browser || '',
      deviceInfo.os || '',
      now,
      now,
      deviceInfo.isBot ? 1 : 0
    );
    
    return result.lastInsertRowid;
  }
}

/**
 * Создать новую сессию
 */
function createSession(visitorId, sessionId) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  const result = db.prepare(`
    INSERT INTO visitor_sessions (visitor_id, session_id, start_time, page_count, action_count)
    VALUES (?, ?, ?, 0, 0)
  `).run(visitorId, sessionId, now);
  
  return result.lastInsertRowid;
}

/**
 * Получить сессию по sessionId
 */
function getSession(sessionId) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    return null;
  }
  return db.prepare('SELECT * FROM visitor_sessions WHERE session_id = ?').get(sessionId);
}

/**
 * Обновить сессию
 */
function updateSession(sessionId, updates) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    return;
  }
  
  const setParts = [];
  const values = [];
  
  if (updates.pageCount !== undefined) {
    setParts.push('page_count = ?');
    values.push(updates.pageCount);
  }
  if (updates.actionCount !== undefined) {
    setParts.push('action_count = ?');
    values.push(updates.actionCount);
  }
  if (updates.lastPage !== undefined) {
    setParts.push('last_page = ?');
    values.push(updates.lastPage);
  }
  if (updates.telegramMessageId !== undefined) {
    setParts.push('telegram_message_id = ?');
    values.push(updates.telegramMessageId);
  }
  if (updates.endTime !== undefined) {
    setParts.push('end_time = ?');
    values.push(updates.endTime);
  }
  
  if (setParts.length === 0) return;
  
  values.push(sessionId);
  
  db.prepare(`
    UPDATE visitor_sessions 
    SET ${setParts.join(', ')}
    WHERE session_id = ?
  `).run(...values);
}

/**
 * Добавить действие пользователя
 */
function addAction(sessionId, visitorId, actionData) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    INSERT INTO visitor_actions 
    (session_id, visitor_id, action_type, page_path, page_name, field_name, field_value, button_text, action_data, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    visitorId,
    actionData.type || 'unknown',
    actionData.path || null,
    actionData.page || null,
    actionData.field || null,
    actionData.value || null,
    actionData.buttonText || null,
    actionData.data ? JSON.stringify(actionData.data) : null,
    now
  );
  
  // Увеличить счетчик действий в сессии
  db.prepare(`
    UPDATE visitor_sessions 
    SET action_count = action_count + 1
    WHERE session_id = ?
  `).run(sessionId);
}

/**
 * Получить все действия сессии
 */
function getSessionActions(sessionId) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    return [];
  }
  return db.prepare(`
    SELECT * FROM visitor_actions 
    WHERE session_id = ? 
    ORDER BY timestamp ASC
  `).all(sessionId);
}

/**
 * Получить статистику посетителя
 */
function getVisitorStats(visitorId) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    return null;
  }
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(visitorId);
  if (!visitor) return null;
  
  const sessions = db.prepare(`
    SELECT COUNT(*) as count 
    FROM visitor_sessions 
    WHERE visitor_id = ?
  `).get(visitorId);
  
  return {
    ...visitor,
    sessionCount: sessions.count
  };
}

/**
 * Получить количество посещений для IP
 */
function getVisitCount(ip) {
  if (!db) {
    logger.error('[DB] Database not initialized');
    return 0;
  }
  const visitor = db.prepare('SELECT visit_count FROM visitors WHERE ip = ?').get(ip);
  return visitor ? visitor.visit_count : 0;
}

/**
 * Автоматическая очистка данных старше 3 дней
 */
function cleanupOldData() {
  try {
    const threeDaysAgo = Math.floor(Date.now() / 1000) - (3 * 24 * 60 * 60);
    
    // Удалить старые действия
    const actionsDeleted = db.prepare(`
      DELETE FROM visitor_actions 
      WHERE timestamp < ?
    `).run(threeDaysAgo).changes;
    
    // Удалить старые сессии
    const sessionsDeleted = db.prepare(`
      DELETE FROM visitor_sessions 
      WHERE start_time < ?
    `).run(threeDaysAgo).changes;
    
    // Удалить посетителей без сессий
    const visitorsDeleted = db.prepare(`
      DELETE FROM visitors 
      WHERE last_seen < ? 
      AND id NOT IN (SELECT DISTINCT visitor_id FROM visitor_sessions)
    `).run(threeDaysAgo).changes;
    
    if (actionsDeleted > 0 || sessionsDeleted > 0 || visitorsDeleted > 0) {
      logger.info(`[DB] Cleanup: deleted ${actionsDeleted} actions, ${sessionsDeleted} sessions, ${visitorsDeleted} visitors`);
    }
    
    // Оптимизировать базу данных
    db.exec('VACUUM');
    
  } catch (error) {
    logger.error('[DB] Cleanup error:', error.message);
  }
}

/**
 * Запустить автоматическую очистку (каждые 6 часов)
 */
function startAutoCleanup() {
  // Запустить сразу при старте
  cleanupOldData();
  
  // Затем каждые 6 часов
  setInterval(cleanupOldData, 6 * 60 * 60 * 1000);
  
  logger.info('[DB] Auto-cleanup started (runs every 6 hours)');
}

/**
 * Закрыть соединение с базой данных
 */
function closeDatabase() {
  if (db) {
    db.close();
    logger.info('[DB] Database connection closed');
  }
}

// Инициализировать при загрузке модуля (если не запущен напрямую)
// Но лучше вызывать initDatabase() явно из server.js
if (require.main !== module) {
  // Не инициализируем автоматически - нужно вызывать явно
  // initDatabase();
}

module.exports = {
  initDatabase,
  getOrCreateVisitor,
  createSession,
  getSession,
  updateSession,
  addAction,
  getSessionActions,
  getVisitorStats,
  getVisitCount,
  cleanupOldData,
  closeDatabase,
  db: () => db, // Экспорт для прямого доступа если нужно
};
