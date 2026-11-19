import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ThrottleGuard } from './common/throttle.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalGuards(new ThrottleGuard());
  await app.listen(Number(process.env.PORT ?? 3000));
}

bootstrap();
