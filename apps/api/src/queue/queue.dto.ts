import { IsString, IsNotEmpty, IsOptional, IsIn, IsDateString, IsObject, MaxLength, IsNumber, Min, Max } from 'class-validator';

export class CreateQueuedMessageDto {
  @IsString() @IsNotEmpty()
  connectionId!: string;

  @IsString() @IsNotEmpty()
  chatId!: string;

  @IsIn(['text', 'image', 'document', 'video', 'audio'])
  @IsOptional()
  type?: string;

  @IsObject()
  content!: {
    text?: string;
    url?: string;
    caption?: string;
    filename?: string;
    data?: string;
    mimetype?: string;
  };

  @IsOptional()
  @IsDateString()
  scheduledAt?: string; // ISO 8601 — null/undefined = send ASAP

  @IsOptional()
  @IsString() @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsNumber() @Min(0) @Max(10)
  maxRetries?: number;
}
