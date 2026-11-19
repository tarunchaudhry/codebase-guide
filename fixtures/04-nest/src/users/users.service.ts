import { Inject, Injectable } from '@nestjs/common';

export interface CreateUserDto { email: string }

@Injectable()
export class UsersService {
  constructor(@Inject('CONFIG') private readonly config: Record<string, string>) {}

  findAll() {
    return [{ id: '1', email: this.config.adminEmail }];
  }

  findOne(id: string) {
    return this.findAll().find((u) => u.id === id);
  }

  create(dto: CreateUserDto) {
    return { id: '2', ...dto };
  }
}
