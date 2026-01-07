const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const config = require('./config');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
if (!fs.existsSync(config.logging.dir)) {
  fs.mkdirSync(config.logging.dir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create logger
const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    
    // File transport for all logs
    new DailyRotateFile({
      filename: path.join(config.logging.dir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: logFormat,
    }),
    
    // File transport for errors only
    new DailyRotateFile({
      level: 'error',
      filename: path.join(config.logging.dir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      format: logFormat,
    }),
  ],
});

// Request logger
logger.logRequest = (req, res, responseTime) => {
  if (!config.logging.logRequests) return;

  const logData = {
    method: req.method,
    url: req.url,
    statusCode: res.statusCode,
    responseTime: `${responseTime}ms`,
    userAgent: req.get('user-agent'),
    ip: req.ip,
    referer: req.get('referer') || '-',
  };

  logger.info('Request', logData);
};

// Response logger
logger.logResponse = (req, res, body) => {
  if (!config.logging.logResponses) return;

  logger.debug('Response', {
    method: req.method,
    url: req.url,
    statusCode: res.statusCode,
    bodySize: body ? body.length : 0,
  });
};

module.exports = logger;







