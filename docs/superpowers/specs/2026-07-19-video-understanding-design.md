# Leitura híbrida de vídeo

**Status:** aprovado em conversa

**Data:** 2026-07-19

## Problema

O Verboo aceita imagens e arquivos, mas não representa vídeo como um anexo próprio. Um vídeo é tratado como arquivo binário desconhecido; o transporte do turno só possui blocos de imagem, o fallback de visão só considera imagens e o OCR recebe uma imagem por chamada. Mesmo quando um modelo disponível compreende vídeo, o app não descobre nem transporta essa capacidade.

Usuários precisam anexar gravações e vídeos produzidos em macOS, Windows ou Linux e obter uma compreensão conjunta de cenas, movimento, texto visível e áudio/fala. O recurso deve funcionar também quando o modelo principal não possui visão, sem bloquear o renderer, depender de ferramentas instaladas na máquina ou poluir o transcript final.

## Objetivos

- Aceitar um vídeo por mensagem pelo seletor do clipe, drag-and-drop ou colagem de arquivo com `Ctrl+V`/`Cmd+V`.
- Preservar exatamente a ordem visual dos anexos do composer no transcript persistido e no payload do turno.
- Compreender conteúdo visual, mudanças temporais, texto na tela e áudio/fala.
- Usar entrada nativa de vídeo e áudio somente quando catálogo, transporte e formato declararem suporte explícito.
- Usar frames, visão, OCR e transcrição como fallback para capacidades ausentes.
- Entregar ao modelo principal sem visão uma síntese temporal estruturada e compacta.
- Suportar entradas comuns de macOS, Windows e Linux, incluindo SDR e HDR.
- Manter todo trabalho pesado fora da thread da interface, com progresso e cancelamento.
- Manter detalhes técnicos somente em `Worked for`, sem cartão permanente no transcript.
- Empacotar todos os executáveis necessários e baixar o modelo local de transcrição apenas sob demanda.

## Não objetivos

- Analisar vídeos com mais de 5 minutos ou 500 MB.
- Analisar mais de um vídeo na mesma mensagem.
- Oferecer editor ou ferramenta de recorte na primeira versão.
- Analisar DRM, mídia criptografada, vídeo espacial, vídeo 360 graus ou múltiplos ângulos.
- Inferir capacidades de modelos por nome.
- Exigir Node, FFmpeg, ffprobe ou transcritor previamente instalados pelo usuário.
- Manter proxies, áudio extraído ou frames após conclusão, falha ou cancelamento.
- Exibir transcrição, OCR, frames ou diagnóstico técnico no resumo final do transcript.

## Restrições globais

- Duração máxima por arquivo: 5 minutos, inclusive.
- Tamanho máximo por arquivo: 500 MB, inclusive.
- Quantidade máxima: um vídeo por mensagem.
- Arquivos acima dos limites são bloqueados antes do turno; nenhum conteúdo é truncado silenciosamente.
- O arquivo original nunca é alterado.
- O renderer nunca carrega o vídeo completo em memória nem o converte integralmente para base64.
- A preferência de consentimento para imagens não autoriza vídeo.
- Ausência de metadados de capacidade significa capacidade não confirmada e exige fallback.
- A ordem do composer é a fonte de verdade para persistência e envio.

## Arquitetura aprovada

### Fluxo geral

```text
entrada no composer
    -> inspeção assíncrona
    -> validação de tamanho, duração e quantidade
    -> consentimento específico de vídeo
    -> trabalho cancelável em background
    -> roteamento por capacidades declaradas
       -> vídeo e áudio nativos
       -> vídeo nativo + transcrição auxiliar
       -> frames + visão + OCR + transcrição
    -> consolidação temporal
    -> contexto compacto para o modelo principal
    -> limpeza de temporários
```

O backend coordena o trabalho em módulos separados:

- `media_probe`: identifica container, streams, duração, tamanho, codec, resolução, FPS, áudio, profundidade de cor, primárias, matriz e função de transferência.
- `video_preparation`: cria proxy SDR/BT.709, extrai áudio mono de 16 kHz e produz frames selecionados.
- `video_capability_router`: escolhe a rota nativa ou os complementos necessários.
- `video_analysis`: executa e combina visão, OCR, transcrição e resumos por segmento.
- `speech_transcription`: usa áudio nativo, modelo auxiliar compatível ou transcritor local.
- `video_cache`: lê e grava evidências derivadas versionadas e gerencia a limpeza.
- `video_job`: mantém estado, progresso, cancelamento, timeouts e eventos para o renderer.

O serviço de turno consome o resultado final do pipeline. Ele não passa a concentrar probing, transcodificação, OCR ou ASR.

## Contrato do anexo e ordem

`AttachmentKind` passa a aceitar `video`. A metadata compartilhada de um vídeo inclui pelo menos duração, container, codec de vídeo, resolução, FPS, presença de áudio e classificação HDR/SDR. Dados detalhados do probe permanecem no backend e em `Worked for`; o composer recebe apenas o necessário para apresentação e validação.

As três entradas reutilizam uma única fila de ingestão:

1. O clipe reserva a posição antes de abrir a inspeção assíncrona e preserva a ordem retornada pelo seletor.
2. O drop reserva a posição no evento e preserva a ordem de `DataTransfer`.
3. A colagem reserva a posição no evento e lê referências nativas de arquivos do clipboard.
4. Cada lote recebe um número monotônico antes de qualquer `await`.
5. A conclusão fora de ordem de dois lotes não altera as posições reservadas.
6. Um caminho canônico repetido mantém a primeira posição e atualiza apenas sua metadata.
7. O vetor exibido no composer é usado sem nova ordenação na persistência do transcript e em `AgentTurnRequest`.

Arquivos copiados no Finder, Explorer ou gerenciador Linux são lidos como referências nativas. Se o WebView não expuser o caminho, um comando Rust consulta a lista de arquivos do clipboard do sistema. Um blob de vídeo sem caminho só pode ser materializado por transferência em streaming para um temporário controlado pelo app; o caminho de imagem em base64 não será reutilizado para vídeo.

O composer aceita imagens e documentos antes ou depois do único vídeo. Tentar anexar um segundo vídeo mantém o primeiro e apresenta uma mensagem clara, sem iniciar processamento do segundo.

## Formatos e normalização

Containers aceitos inicialmente: MP4, MOV, WebM, MKV, AVI e M4V. A aceitação depende do probe e da capacidade real do decoder empacotado, não apenas da extensão.

Os decoders da distribuição devem cobrir pelo menos H.264/AVC, HEVC/H.265, VP8, VP9, AV1 e Apple ProRes nos containers compatíveis. Entradas de gravação de tela do macOS em H.264/SDR e HEVC/HDR são casos obrigatórios.

O probe classifica HDR por características do stream, incluindo HLG, PQ, BT.2020 e metadados HDR reconhecidos. Para análise por frames ou por um modelo que não declare suporte ao formato original, `video_preparation` cria um proxy SDR/BT.709 com tone mapping determinístico. Frames de OCR preservam resolução suficiente para texto pequeno, com limite de borda longa aplicado somente após considerar a densidade do conteúdo.

O original só pode ser enviado diretamente quando modelo e transporte declaram suporte ao container, codec, áudio e HDR presentes. Caso contrário, a rota nativa recebe o proxy normalizado. O proxy é criado por streaming e apagado ao final.

FFmpeg e ffprobe são sidecars por target, com versão fixada, build reproduzível e configuração compatível com distribuição. Origem, licença, opções de build, checksum e inventário de codecs ficam documentados no repositório. O app nunca resolve uma instalação arbitrária do PATH como dependência do recurso.

## Capacidades e roteamento

O catálogo normalizado passa a representar separadamente:

- suporte a imagem;
- suporte a vídeo;
- suporte a áudio;
- containers e codecs aceitos, quando informados;
- suporte a HDR, quando informado;
- suporte do transporte do CLI a cada modalidade.

O roteador usa a interseção entre capacidade do modelo, capacidade do transporte e características do arquivo:

| Vídeo | Áudio | Rota |
|---|---|---|
| Confirmado | Confirmado | Enviar original compatível ou proxy normalizado |
| Confirmado | Ausente | Enviar vídeo e acrescentar transcrição auxiliar |
| Ausente | Confirmado ou ausente | Extrair frames; usar visão, OCR e transcrição disponível |
| Desconhecido | Qualquer | Tratar vídeo como não suportado e usar fallback |

Nenhuma heurística baseada em nome do modelo autoriza envio nativo. Se o catálogo declarar vídeo mas o CLI não possuir um bloco de transporte compatível, a capacidade efetiva é falsa.

## Amostragem visual, OCR e consolidação

Na rota por frames, o pipeline cria uma linha de base temporal de no máximo um frame a cada 5 segundos e acrescenta frames de mudança de cena. Duplicatas perceptuais são removidas. O teto é 120 frames por vídeo: até 60 amostras periódicas e até 60 amostras de cenas relevantes.

Os frames são agrupados em lotes com timestamps visíveis para o modelo auxiliar. A análise retorna segmentos estruturados contendo:

- início e fim;
- descrição visual;
- ações ou mudanças observadas;
- fala transcrita;
- texto visível obtido por OCR;
- confiança e limitações por canal.

OCR é complementar à visão. Ele é executado com o worker existente reutilizado e uma fila limitada, priorizando frames de mudança de cena e regiões com provável texto. No máximo 60 frames passam por OCR. Pré-processamento pode redimensionar, converter para escala de cinza, binarizar e corrigir inclinação sem substituir o frame visual original.

A consolidação combina segmentos adjacentes, remove repetições e gera uma descrição compacta com timestamps. O modelo principal recebe essa representação como evidência derivada do vídeo; não recebe centenas de blocos independentes.

## Áudio e transcrição local

Quando vídeo e transporte oferecem áudio nativo, o modelo recebe a faixa como parte da mídia. Quando apenas vídeo é suportado, um modelo auxiliar com áudio produz a transcrição. Quando nenhum modelo ou transporte aceita áudio, o app oferece o componente local aprovado.

O fallback local usa `whisper.cpp` como sidecar e o modelo multilíngue `ggml-base.bin`, baixado sob demanda. O modelo não integra o instalador inicial. O download exige confirmação, mostra progresso, usa um manifesto versionado com tamanho e SHA-256 e só é promovido ao cache após verificação de integridade. Downloads interrompidos não são tratados como instalações válidas.

A extração fornece PCM mono de 16 kHz ao transcritor. O idioma é detectado automaticamente e os segmentos mantêm timestamps. CPU é a base obrigatória; aceleração específica de plataforma pode ser usada apenas quando disponível e sem alterar o contrato. O usuário pode remover o modelo baixado nas configurações.

## Consentimento e privacidade

Vídeo possui preferência independente com `ask`, `always` e `never`:

- `ask`: exibir Permitir desta vez, Sempre permitir e Nunca permitir.
- `always`: iniciar após validação sem repetir o modal.
- `never`: não processar nem enviar o vídeo.

O aviso informa antes do envio se a rota utilizará o original, um proxy normalizado ou frames e áudio. A descrição identifica que modelos auxiliares podem receber dados derivados. Uma mudança material de método que amplie o envio invalida o consentimento daquele turno e exige nova confirmação.

Logs não incluem frames, áudio, transcrição completa, conteúdo OCR, tokens ou caminhos privados. Diagnóstico pode registrar duração, codec, etapa, tempo, resultado, cache hit/miss e códigos sanitizados de erro.

## Estado no composer e transcript

Ao anexar, o chip passa por `validating`, `ready` ou `invalid`. O chip mostra somente ícone, nome e estado necessário. Duração, codec e HDR não ocupam permanentemente o composer.

Durante o turno, um único indicador temporário apresenta:

```text
Validando -> Preparando vídeo -> Transcrevendo áudio
-> Analisando cenas e textos -> Consolidando
```

O indicador possui Cancelar. Ao concluir, ele desaparece. Não existe cartão persistente de vídeo no transcript além do chip normal do anexo na mensagem do usuário.

Detalhes de método, modelos auxiliares, timestamps, quantidade de frames, OCR, transcrição, normalização, cache e degradações aparecem somente dentro de `Worked for`. A resposta final permanece limpa e orientada ao pedido do usuário.

## Cancelamento, falhas e recuperação

O trabalho possui token de cancelamento propagado a preparação, visão, OCR, transcrição e consolidação. Cancelar encerra subprocessos, impede que resultados tardios alterem o turno e agenda a limpeza de temporários. O encerramento do app executa a mesma limpeza no próximo início para diretórios abandonados.

Falhas parciais preservam evidências válidas:

- ausência de áudio continua com visual e OCR;
- falha de OCR continua com visão e transcrição;
- falha do primeiro modelo auxiliar tenta o próximo modelo compatível;
- falha de ASR remoto oferece ou usa o fallback local autorizado;
- falha do proxy tenta frames diretos somente quando o decoder e o espaço de cor produzem saída segura;
- vídeo inválido, protegido, acima dos limites ou sem qualquer canal utilizável falha antes de chamar o modelo principal.

O resultado final enumera limitações relevantes para o modelo principal. Erros técnicos detalhados ficam em `Worked for`; o usuário recebe mensagem curta e acionável.

## Cache e temporários

A chave de cache inclui hash do vídeo, versão do pipeline, parâmetros de amostragem, normalização e identificadores das capacidades efetivamente usadas. Alterar o arquivo ou a versão invalida o resultado.

O cache persistente guarda apenas a representação temporal derivada e metadata necessária. Proxy, áudio PCM e frames vivem em um diretório de trabalho exclusivo e são apagados em sucesso, erro ou cancelamento. Uma rotina de inicialização remove diretórios incompletos antigos sem tocar arquivos do usuário.

## Desempenho

- Probe, hash e transcodificação usam leitura por streaming.
- Apenas um trabalho de vídeo pesado executa por vez por processo do app.
- OCR, visão e ASR possuem filas limitadas; nenhuma delas cria concorrência proporcional à quantidade de frames.
- A UI recebe eventos pequenos de estado, nunca buffers de mídia.
- Digitação, scroll, troca de chat e abertura de painéis permanecem utilizáveis durante o processamento.
- Timeouts encerram processos auxiliares e preservam os canais já concluídos quando possível.

## Verificação

### Testes automatizados

- Probe de duração, tamanho, streams, codecs, SDR e HDR.
- Fronteiras inclusivas de 5 minutos e 500 MB e rejeição imediatamente acima.
- Um vídeo por mensagem com imagens e documentos em qualquer posição.
- Ordem de seletor, drop e clipboard, inclusive quando inspeções terminam fora de ordem.
- Deduplicação preservando a primeira posição.
- Matriz de roteamento por modelo, transporte, codec e HDR.
- Amostragem e tetos de 120 frames visuais e 60 frames de OCR.
- Consentimento independente e mudança material de rota.
- Cache, invalidação, limpeza, cancelamento e descarte de eventos tardios.
- Download interrompido e checksum inválido do modelo ASR.
- Recuperação quando visual, OCR ou áudio falham isoladamente.

### Fixtures

- MP4/H.264 SDR com áudio.
- MOV/HEVC HDR com HLG ou PQ.
- WebM/VP9.
- AV1, ProRes e vídeo sem áudio.
- Texto pequeno, movimento rápido, fala em português e inglês e mudanças de cena.
- Arquivo corrompido, protegido e arquivo sem stream de vídeo.
- Casos nas fronteiras de duração e tamanho, gerados no teste sem armazenar artefatos de 500 MB no Git.

### Matriz empacotada

- macOS Apple Silicon e Intel.
- Windows x64.
- Linux x64.
- Máquina limpa sem Node, FFmpeg, ffprobe ou modelo ASR instalado.
- Máquina com 8 GB de RAM e CPU modesta.
- Modelos com vídeo+áudio, somente vídeo, somente imagem e somente texto.
- Entrada pelo clipe, drop e clipboard.
- Troca de chat, cancelamento e fechamento do app durante cada etapa.

### Gate visual com @Computador

Depois de testes automatizados e build de release passarem:

1. Empacotar o app da branch de desenvolvimento para o target local.
2. Substituir a instalação anterior pelo novo bundle autorizado.
3. Abrir o app instalado, não o servidor de desenvolvimento.
4. Usar exclusivamente o @Computador para a interação visual solicitada: anexar por clipe, drop e `Cmd+V`, confirmar ordem, consentimento, progresso, cancelamento, ausência de poluição no transcript e detalhes em `Worked for`.
5. Exercitar pelo menos um MOV nativo do macOS e um vídeo que force fallback por frames.
6. Reconsultar o estado do app após cada ação e registrar evidência visual fresca; testes de código não substituem esse gate.

## Critérios de aceite

- Um vídeo válido de até 5 minutos e 500 MB pode ser anexado pelos três caminhos.
- Um segundo vídeo na mesma mensagem é recusado sem remover o primeiro.
- Ordem no composer, transcript e backend é idêntica.
- Vídeo HDR nativo é detectado e normalizado corretamente quando necessário.
- O roteador nunca autoriza modalidade por heurística de nome.
- O modelo principal recebe compreensão conjunta de visual, OCR e fala, ou uma limitação explícita por canal.
- Falha parcial não descarta canais válidos.
- O renderer permanece responsivo e não materializa o vídeo em base64.
- Nenhuma ferramenta externa precisa estar instalada pelo usuário.
- Temporários são removidos em sucesso, erro e cancelamento.
- O transcript final não contém diagnóstico técnico fora de `Worked for`.
- O app empacotado passa pelo gate visual final com @Computador.
