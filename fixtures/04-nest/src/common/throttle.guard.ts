import { CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class ThrottleGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
