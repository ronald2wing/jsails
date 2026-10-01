/**
 * HTTP client (`jsails/http`).
 *
 * A thin fetch-based HTTP client seam with JSON encoding/decoding, bounded
 * timeouts, retries, a test fake, and value-free error reporting.
 */

export {
  FetchHttpClient,
  HttpClientError,
  type HttpClient,
  type HttpClientOptions,
  type RequestOptions,
} from './client.js';

export {
  FakeHttpClientImpl,
  type FakeHttpClient,
  type FakeHttpHandler,
  type FakeHttpRequest,
  type FakeHttpResponse,
} from './fake.js';
