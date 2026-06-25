# C1 gap vocabulary audit

- Final CSV: `/home/rootadmin/active-timed-recall-app/src/data/generated/c1_gap_vocabulary_collocations.csv`
- Existing frequency source: `/home/rootadmin/Spanish-daily-verb-project/mas frecuente palabras en espanol.txt`
- Existing frequency terms parsed: 810
- Final row count: 1466
- LLM quality-review removals: 61 (`/home/rootadmin/active-timed-recall-app/reports/c1_gap_vocabulary_removed_rows.csv`)

## Validation

- CSV header: ['spanish', 'english', 'domain', 'collocations']
- Missing required fields: 0
- Duplicate normalized Spanish items: 0
- Overlaps with existing frequency list: 0
- Rows with fewer than 3 collocations: 0
- Infinitive/conjugated-verb-looking item hits: 0

## Domain counts

- transport: 109
- health: 107
- work: 101
- housing: 100
- family: 91
- food: 79
- education: 78
- clothing: 69
- travel: 64
- tech: 61
- media: 60
- money: 59
- safety: 57
- legal: 55
- environment: 54
- community: 43
- errands: 39
- tools: 32
- admin: 30
- repairs: 26
- utilities: 26
- materials: 24
- emergency: 23
- weather: 23
- shopping: 20
- emotion: 15
- social: 12
- culture: 9

## Cross-domain sample rows

- el retraso | delay | transport | acumular un retraso; sufrir un retraso; notificar un retraso; evitar el retraso
- el síntoma | symptom | health | aliviar el síntoma; tratar el síntoma; detectar el síntoma; ignorar el síntoma
- la vacante | vacancy | work | cubrir una vacante; anunciar una vacante; solicitar una vacante; ocupar una vacante
- el rodapié | baseboard/skirting board | housing | instalar el rodapié; barnizar el rodapié; fijar el rodapié; cambiar el rodapié
- el entorno familiar | family environment | family | crecer en el entorno familiar; proteger el entorno familiar; valorar el entorno familiar
- la despensa | pantry | food | llenar la despensa; organizar la despensa; vaciar la despensa
- el hallazgo | discovery/finding | education | hacer un hallazgo; publicar un hallazgo; confirmar un hallazgo; respaldar un hallazgo
- el tejido | fabric/textile | clothing | la calidad del tejido; un tejido resistente; elegir el tejido
- la estancia | stay | travel | prolongar la estancia; disfrutar la estancia; acortar la estancia; pagar la estancia
- la brecha | gap/breach | tech | detectar una brecha; cerrar una brecha; sufrir una brecha; proteger contra una brecha
- el titular | headline | media | leer el titular; redactar el titular; cambiar el titular; destacar el titular
- el aval | guarantee/collateral | money | solicitar un aval; presentar un aval; exigir un aval; conceder un aval
- el protocolo | protocol | safety | seguir el protocolo; establecer un protocolo; violar el protocolo; diseñar un protocolo
- la cláusula | clause | legal | incluir una cláusula; redactar una cláusula; anular una cláusula; estipular una cláusula
- la huella ecológica | ecological footprint | environment | reducir la huella ecológica; medir la huella ecológica; compensar la huella ecológica
- la convivencia | coexistence | community | mejorar la convivencia; fomentar la convivencia; facilitar la convivencia; arruinar la convivencia
- la lavandería | laundry (place) | errands | llevar a la lavandería; la ropa de la lavandería; el servicio de lavandería
- la arandela | washer | tools | colocar la arandela; ajustar la arandela; buscar la arandela; apretar la arandela

## Quality notes

- This is a lightweight verb-drill source list, not a formal dictionary.
- Domains are loose labels only; collocations are the important payload for future post-conjugation drills.
- The list intentionally excludes the existing “más frecuente palabras en español” base list and therefore leans toward adult C1 gap vocabulary/chunks.
- Removed rows were flagged by an LLM quality pass for being too basic, too technical, duplicate-like, unnatural, or weak for verb drills.
