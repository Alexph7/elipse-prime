ELIPSE PRIME - PROJETO INDEPENDENTE

1. No VS Code, abra esta pasta.
2. Copie .env.example para .env e preencha TOKEN, CANAL_ID e AMAZON_COOKIE.
   Use um token de bot DIFERENTE do Elipse original para evitar conflito de polling.
3. Substitua os quatro URLs de sentinelas.json pelos quatro produtos escolhidos.
4. Coloque pelo menos uma imagem .jpg/.png em imagem/ (necessaria para postar).
5. Substitua afiliacao.json pelos links afiliados de ASIN se desejar.
6. Rode: npm install
7. Valide: npm run check
8. Rode: npm start

FUNCIONAMENTO: Brasil/Sao_Paulo, 07:00-23:30 e 00:00.
Às HH:00:00 e HH:00:10, e HH:30:00. Quatro produtos iniciados com
2 segundos de diferenca; as requisicoes podem se sobrepor se forem lentas.
Uma ronda so inicia se a anterior tiver terminado; slots perdidos nao
sao reexecutados em atraso.

Cada promotion ID tem ate 2 respostas VALIDAS no popup, mas para de
consultar imediatamente depois que um cupom completo dele e enviado.
Ids repetidos entre os quatro produtos sao consultados uma vez por ronda.
O popup e a unica fonte de dados completos. HTML de produto so fornece IDs.

AVISO: o historico de postagens e separado do Elipse original. Se publicar
no mesmo canal, dois bots independentes podem publicar o mesmo codigo.
Use primeiro um CANAL_ID de teste.

O .env contem credenciais de sessao. NAO publique nem compartilhe.
