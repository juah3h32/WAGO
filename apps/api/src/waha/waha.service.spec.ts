import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WahaService } from './waha.service';

describe('WahaService', () => {
  let service: WahaService;
  let fetchSpy: jest.SpyInstance;

  const workerUrl = '10.0.0.1';
  const apiKey = 'test-api-key';

  function mockFetchResponse(body: any, status = 200, ok = true) {
    return {
      ok,
      status,
      text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WahaService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def: string) => {
              if (key === 'WAHA_PORT') return '8080';
              if (key === 'WAHA_MAX_SESSIONS') return '1';
              return def ?? '1';
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WahaService>(WahaService);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockFetchResponse({}));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('createSession', () => {
    it('should call Evolution API create endpoint with correct URL and headers', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ instance: { instanceName: 'test-session' } }));

      await service.createSession(workerUrl, apiKey, 'test-session', 'https://hooks.example.com/wh');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:8080/instance/create');
      expect(options.method).toBe('POST');
      expect(options.headers['apikey']).toBe(apiKey);

      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.instanceName).toBe('test-session');
      expect(parsedBody.webhook.url).toBe('https://hooks.example.com/wh');
    });

    it('should create session without webhook when no webhookUrl provided', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ instance: { instanceName: 'sess' } }));

      await service.createSession(workerUrl, apiKey, 'sess');

      const parsedBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(parsedBody.webhook).toBeUndefined();
    });

    it('should return mapped session response', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ instance: { instanceName: 'my-session' }, connectionStatus: { state: 'open' } }));

      const result = await service.createSession(workerUrl, apiKey, 'my-session');
      expect(result.name).toBe('my-session');
    });
  });

  describe('startSession', () => {
    it('should call Evolution API connect endpoint with GET', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ base64: 'data:image/png;base64,abc' }));

      await service.startSession(workerUrl, apiKey, 'my-session');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:8080/instance/connect/my-session');
      expect(options.method).toBe('GET');
      expect(options.headers['apikey']).toBe(apiKey);
    });
  });

  describe('stopSession', () => {
    it('should call Evolution API logout endpoint', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(''));

      await service.stopSession(workerUrl, apiKey, 'my-session');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:8080/instance/logout/my-session');
      expect(options.method).toBe('DELETE');
    });
  });

  describe('getQrCode', () => {
    it('should call connect endpoint and parse base64 QR', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ base64: 'data:image/png;base64,abc123' }));

      const result = await service.getQrCode(workerUrl, apiKey, 'my-session');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:8080/instance/connect/my-session');
      expect(result.mimetype).toBe('image/png');
      expect(result.value).toBe('abc123');
    });

    it('should throw 503 when QR not ready', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ status: 'connecting' }));

      await expect(service.getQrCode(workerUrl, apiKey, 'my-session')).rejects.toThrow();
    });
  });

  describe('error handling', () => {
    it('should throw on HTTP errors with descriptive message', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse('Not Found', 404, false));

      await expect(
        service.createSession(workerUrl, apiKey, 'fail-session'),
      ).rejects.toThrow('WAHA API error');
    });

    it('should throw on timeout (AbortError)', async () => {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      fetchSpy.mockRejectedValueOnce(abortError);

      await expect(
        service.createSession(workerUrl, apiKey, 'timeout-session'),
      ).rejects.toThrow('WAHA API timeout');
    });

    it('should re-throw unexpected errors', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));

      await expect(
        service.createSession(workerUrl, apiKey, 'err-session'),
      ).rejects.toThrow('Network failure');
    });
  });

  describe('downloadMediaByMessageKey', () => {
    it('should call Evolution API getBase64FromMediaMessage with the correct key', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({
        base64: 'abc123',
        mimetype: 'application/pdf',
        fileName: 'doc.pdf',
        mediaType: 'document',
      }));

      const result = await service.downloadMediaByMessageKey(
        workerUrl, apiKey, 'default',
        'MSG_ID_001', '5521999@s.whatsapp.net', false,
      );

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:8080/chat/getBase64FromMediaMessage/default');
      expect(options.method).toBe('POST');
      expect(options.headers['apikey']).toBe(apiKey);

      const body = JSON.parse(options.body);
      expect(body.message.key.id).toBe('MSG_ID_001');
      expect(body.message.key.remoteJid).toBe('5521999@s.whatsapp.net');
      expect(body.message.key.fromMe).toBe(false);

      expect(result.base64).toBe('abc123');
      expect(result.mimetype).toBe('application/pdf');
      expect(result.fileName).toBe('doc.pdf');
    });
  });
});
