import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MAM Control API',
      version: '1.0.0',
      description: 'Documentação completa da API do sistema de controle de acesso MAM Control. Esta API permite a integração com outros sistemas e o desenvolvimento de aplicativos móveis.',
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
      contact: {
        name: 'Suporte MAM Control',
        email: 'suporte@mamcontrol.com.br',
      },
    },
    servers: [
      {
        url: '/api/v1',
        description: 'Servidor API v1 (relativo)',
      },
      {
        url: 'http://localhost:3000/api/v1',
        description: 'Servidor de Desenvolvimento Local (v1)',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Insira o token JWT retornado pelo endpoint /auth/login para autenticar as requisições.'
        },
        tenantId: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Tenant-ID',
          description: 'ID do cliente para isolamento de dados. Obrigatório para a maioria das operações.',
        },
      },
      parameters: {
        tenantIdHeader: {
          in: 'header',
          name: 'X-Tenant-ID',
          schema: {
            type: 'string'
          },
          required: true,
          description: 'ID do cliente para isolamento de dados.'
        }
      }
    },
    security: [
      {
        tenantId: [],
        bearerAuth: [],
      },
    ],
  },
  // Documentar todos os arquivos de rotas e controllers
  apis: [
    './src/routes/*.js',
    './src/controllers/*.js',
    './server.js'
  ],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
