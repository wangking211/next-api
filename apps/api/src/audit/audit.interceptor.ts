import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditService } from './audit.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTATING = ['POST', 'PATCH', 'PUT', 'DELETE'];

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    if (!MUTATING.includes(req.method)) return next.handle();

    const res = context.switchToHttp().getResponse();
    return next.handle().pipe(
      tap({
        next: () => this.write(req, res.statusCode ?? 200),
        error: (err) => this.write(req, err?.status ?? err?.statusCode ?? 500),
      }),
    );
  }

  private write(req: any, statusCode: number): void {
    const actor = req.gateway?.user ?? req.user ?? null;
    const clean = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    const segs = clean.split('/').filter(Boolean);
    const targetType = segs[1] ?? null;
    const targetId = req.params?.id ?? null;
    const actionPath = segs
      .slice(1)
      .map((s: string) => (UUID_RE.test(s) ? ':id' : s))
      .join('/');
    const forwarded = req.headers?.['x-forwarded-for'];

    void this.audit.record({
      actorId: actor?.id ?? null,
      actorName: actor?.username ?? null,
      actorRole: actor?.role ?? null,
      action: `${req.method} ${actionPath}`,
      method: req.method,
      path: clean,
      statusCode,
      targetType,
      targetId,
      metadata:
        req.params && Object.keys(req.params).length ? { params: req.params } : undefined,
      ip: (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ?? req.ip ?? null,
      userAgent: req.headers?.['user-agent'] ?? null,
    });
  }
}
