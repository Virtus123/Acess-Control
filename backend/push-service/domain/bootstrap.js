export function buildBootstrapPayload(equipment) {
  // Configurações básicas padrão
  const serverUrl = 'http://' + (process.env.VPS_IP || '127.0.0.1') + '/api/push';
  const monitorUrl = 'http://' + (process.env.VPS_IP || '127.0.0.1') + '/api/online';
  
  const config = {
    push_server: { push_request_timeout: '25', push_request_period: '10', push_remote_address: serverUrl },
  };

  return {
    verb: 'POST',
    endpoint: 'set_configuration',
    contentType: 'application/json',
    body: config
  };
}
