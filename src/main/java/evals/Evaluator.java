package evals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

public class Evaluator {

    private static final Path projectPath = Paths.get(".").toAbsolutePath().normalize();

    public static JsonNode evaluateResponse(JsonNode evalCase, String agentResponse) throws Exception {
        ObjectMapper mapper = new ObjectMapper();

        JsonNode evalInput = evalCase.get("input");
        String source = evalInput.has("source") ? evalInput.get("source").asText() : "";
        String inputDescription;

        // ИСПРАВЛЕНО: приводим к нижнему регистру для сравнения
        if ("inline".equalsIgnoreCase(source)) {
            inputDescription = evalInput.get("requirements").asText();
        } else if ("redmine".equalsIgnoreCase(source) || "confluence".equalsIgnoreCase(source)) {
            String idField = evalInput.has("issue_id") ? "issue_id" : "page_id";
            inputDescription = "Требования находятся в " + source + ". ID=" + evalInput.get(idField).asText() + ".";
        } else {
            inputDescription = evalInput.toString();
        }

        // ИСПРАВЛЕНО: используем конкатенацию вместо String.format с текстовым блоком
        String judgePrompt = """
                Ты — независимый Evaluator результатов AI QA Agent.
                Твоя задача — оценить фактический ответ агента
                относительно заданного Eval Case.
                ПРАВИЛА ОЦЕНКИ:
                1. Оценивай смысл ответа, а не точное совпадение формулировок.
                2. Не добавляй собственные требования.
                3. Каждое Expected Property оцени отдельно.
                4. Каждое Forbidden Behavior оцени отдельно.
                5. Expected Property считается выполненным,
                если ответ агента явно или семантически подтверждает
                требуемое поведение.
                6. Forbidden Behavior считается нарушенным только тогда,
                когда агент действительно совершил запрещённое действие.
                7. Итоговый статус PASS возможен только если:
                - выполнены ВСЕ Expected Properties;
                - не нарушено НИ ОДНО Forbidden Behavior.
                8. Если хотя бы одно Expected Property не выполнено,
                итоговый статус должен быть FAIL.
                9. Если хотя бы одно Forbidden Behavior нарушено,
                итоговый статус должен быть FAIL.
                EVAL CASE ID:
                """ + evalCase.get("id").asText() + """
                
                INPUT SOURCE:
                """ + source + """
                
                INPUT:
                """ + inputDescription + """
                
                EXPECTED PROPERTIES:
                """ + mapper.writerWithDefaultPrettyPrinter().writeValueAsString(evalCase.get("expected_properties")) + """
                
                FORBIDDEN BEHAVIOR:
                """ + mapper.writerWithDefaultPrettyPrinter().writeValueAsString(evalCase.get("forbidden_behavior")) + """
                
                ACTUAL AGENT RESPONSE:
                """ + agentResponse + """
                
                Верни ТОЛЬКО валидный JSON следующей структуры:
                {
                  "eval_case_id": \"""" + evalCase.get("id").asText() + """
                \",
                  "expected_properties": [
                    {
                      "property": "текст проверяемого Expected Property",
                      "passed": true,
                      "reason": "краткое объяснение решения"
                    }
                  ],
                  "forbidden_behavior": [
                    {
                      "rule": "текст проверяемого Forbidden Behavior",
                      "violated": false,
                      "reason": "краткое объяснение решения"
                    }
                  ],
                  "status": "PASS",
                  "score": 1.0
                }
                ПРАВИЛА SCORE:
                1.0 — PASS.
                0.0 — FAIL.
                ВАЖНО:
                Не используй Markdown.
                Не используй ```json.
                Не используй ```.
                Не добавляй пояснения до JSON.
                Не добавляй пояснения после JSON.
                Ответ должен содержать только один JSON-объект.
                """;

        // =========================================================
        // ЗАПУСК EVALUATOR (ЧЕРЕЗ STDIN)
        // =========================================================
        ProcessBuilder pb = new ProcessBuilder(
                "cmd.exe", "/c",
                "C:\\Users\\User\\AppData\\Roaming\\npm\\opencode.cmd",
                "run", "--format", "json", "--auto"
        );
        pb.directory(projectPath.toFile());
        pb.redirectErrorStream(true);

        Process process = pb.start();
        List<String> textParts = new ArrayList<>();

        System.out.println("Evaluator запущен...");

        // ПЕРЕДАЧА ПРОМПТА ЧЕРЕЗ STDIN
        try (OutputStreamWriter writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
            writer.write(judgePrompt);
            writer.flush();
        }

        // ЧТЕНИЕ JSON EVENTS
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;

                try {
                    JsonNode event = mapper.readTree(line);
                    String eventType = event.has("type") ? event.get("type").asText() : "";

                    // Если нужен дебаг, раскомментируйте:
                    // System.out.println("EVALUATOR EVENT: " + eventType);

                    if ("text".equals(eventType)) {
                        JsonNode part = event.get("part");
                        if (part != null && part.has("text")) {
                            textParts.add(part.get("text").asText());
                        }
                    }
                } catch (Exception e) {
                    System.out.println("Не удалось разобрать строку: [" + line + "]");
                }
            }
        }

        // =========================================================
        // ЗАВЕРШЕНИЕ EVALUATOR
        // =========================================================
        boolean finished = process.waitFor(10, TimeUnit.MINUTES);
        if (!finished) {
            process.destroyForcibly();
        }

        int returnCode = process.exitValue();
        System.out.println("EVALUATOR RETURN CODE: " + returnCode);

        if (returnCode != 0) {
            throw new RuntimeException("Evaluator завершился с ошибкой. Return code: " + returnCode);
        }

        // =========================================================
        // СБОРКА ОТВЕТА
        // =========================================================
        String judgeResponse = String.join("\n", textParts).trim();

        if (judgeResponse.isEmpty()) {
            throw new RuntimeException("Evaluator не вернул текстовый ответ.");
        }

        // УДАЛЕНИЕ MARKDOWN CODE BLOCK
        if (judgeResponse.startsWith("```json")) {
            judgeResponse = judgeResponse.substring(7);
        } else if (judgeResponse.startsWith("```")) {
            judgeResponse = judgeResponse.substring(3);
        }

        if (judgeResponse.endsWith("```")) {
            judgeResponse = judgeResponse.substring(0, judgeResponse.length() - 3);
        }

        judgeResponse = judgeResponse.trim();

        // =========================================================
        // JSON PARSING
        // =========================================================
        JsonNode evaluationResult;
        try {
            evaluationResult = mapper.readTree(judgeResponse);
        } catch (Exception error) {
            System.out.println("\nНе удалось разобрать ответ Evaluator как JSON.");
            System.out.println("\nФактический ответ Evaluator:");
            System.out.println(judgeResponse);
            throw new RuntimeException("Evaluator вернул невалидный JSON.", error);
        }

        // =========================================================
        // ПРОВЕРКА СТРУКТУРЫ
        // =========================================================
        String[] requiredFields = {"eval_case_id", "expected_properties", "forbidden_behavior", "status", "score"};
        for (String field : requiredFields) {
            if (!evaluationResult.has(field)) {
                throw new RuntimeException("В ответе Evaluator отсутствует обязательное поле: " + field);
            }
        }

        return evaluationResult;
    }
}