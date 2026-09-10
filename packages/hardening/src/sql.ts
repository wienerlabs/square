export interface SqlClient {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
