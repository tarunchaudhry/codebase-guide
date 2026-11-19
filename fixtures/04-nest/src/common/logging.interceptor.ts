import { CallHandler, Injectable, NestInterceptor } from '@nestjs/common';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(_ctx: unknown, next: CallHandler) {
    return next.handle();
  }
}
