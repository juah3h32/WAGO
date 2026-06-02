import {
  IsString,
  IsArray,
  IsOptional,
  IsBoolean,
  IsUrl,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

// Block SSRF: reject localhost, private IP ranges, and non-http(s) schemes.
// Bypass when ALLOW_LOCAL_WEBHOOKS=true (dev/testing only).
function IsPublicHttpUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPublicHttpUrl',
      target: (object as any).constructor,
      propertyName,
      options: {
        message: 'url must be a public http or https URL (localhost and private IPs are not allowed)',
        ...options,
      },
      validator: {
        validate(value: any, _args: ValidationArguments) {
          if (typeof value !== 'string') return false;

          // Allow local URLs in dev/test environments
          if (process.env.ALLOW_LOCAL_WEBHOOKS === 'true') {
            try { new URL(value); return true; } catch { return false; }
          }

          let parsed: URL;
          try {
            parsed = new URL(value);
          } catch {
            return false;
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
          const host = parsed.hostname.toLowerCase();

          if (host === 'localhost') return false;

          // Strip IPv6 brackets
          let addr = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

          // Resolve IPv4-mapped IPv6 (::ffff:x.x.x.x) to plain IPv4
          const ipv4Mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
          if (ipv4Mapped) addr = ipv4Mapped[1];

          // Block IPv4 private/special ranges
          const privateRangesV4 = [
            /^127\./,
            /^10\./,
            /^172\.(1[6-9]|2\d|3[01])\./,
            /^192\.168\./,
            /^169\.254\./,
            /^0\./,
          ];
          for (const re of privateRangesV4) {
            if (re.test(addr)) return false;
          }

          // Block IPv6 loopback, link-local (fe80::/10), ULA (fc00::/7)
          if (addr === '::1' || addr === '::') return false;
          if (/^fe[89ab][0-9a-f]:/i.test(addr)) return false;
          if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return false;

          return true;
        },
      },
    });
  };
}

export class CreateWebhookDto {
  @IsUrl({ require_tld: false })
  @IsPublicHttpUrl()
  url!: string;

  @IsArray()
  @IsString({ each: true })
  events!: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  @IsPublicHttpUrl()
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
