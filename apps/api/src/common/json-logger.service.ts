import { LoggerService, LogLevel } from '@nestjs/common';

/** JSON 行日志级别（生产环境全量；错误另写 stderr 便于 docker logs 分流） */
const LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

/**
 * 生产环境结构化日志：每行一个 JSON 对象（time/level/context/message[/stack]），
 * 供日志采集/Loki/dockers logs 解析。开发环境不用（保持 Nest 默认彩色可读输出）。
 *
 * 只做最小实现：Nest 内部与代码里的 Logger.log/warn/error 调用都走这里；
 * 对象 message 做 JSON.stringify，Error 取 message + stack。
 */
export class JsonLogger implements LoggerService {
  private levels = new Set<LogLevel>(LEVELS);

  log(message: unknown, context?: string): void {
    this.write('log', message, undefined, context);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, undefined, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    const isStack = typeof stackOrContext === 'string' && stackOrContext.includes('\n');
    this.write('error', message, stackOrContext, isStack ? context : (context ?? stackOrContext));
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, undefined, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, undefined, context);
  }
  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, undefined, context);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.levels = new Set(levels);
  }

  private write(level: LogLevel, message: unknown, stack?: string, context?: string): void {
    if (!this.levels.has(level)) return;
    let msg: string;
    if (message instanceof Error) {
      msg = message.message;
      stack = stack ?? message.stack;
    } else if (typeof message === 'string') {
      msg = message;
    } else {
      try {
        msg = JSON.stringify(message);
      } catch {
        msg = String(message);
      }
    }
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: msg,
      ...(stack ? { stack } : {}),
    });
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}
