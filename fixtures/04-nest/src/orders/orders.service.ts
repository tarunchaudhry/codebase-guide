import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';

@Injectable()
export class OrdersService {
  constructor(private readonly users: UsersService) {}

  list() {
    return this.users.findAll().map((u) => ({ owner: u.id }));
  }
}
