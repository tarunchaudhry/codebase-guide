import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '../common/auth.guard';
import { LoggingInterceptor } from '../common/logging.interceptor';
import { CreateUserDto, UsersService } from './users.service';

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Post()
  @UseInterceptors(LoggingInterceptor)
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }
}
