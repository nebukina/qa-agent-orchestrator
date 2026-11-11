package evals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.TimeUnit;

public class EvalRunner {

    // =============================================================
    // PATHS
    // =============================================================
    private static final Path projectPath = Paths.get(".").toAbsolutePath().normalize();
    private static final Path datasetPath = Paths.get("src", "main", "resources", "dataset", "golden_dataset.json");

    // =============================================================
    // QUALITY GATE THRESHOLDS
    // =============================================================
    private static final double MIN_PASS_RATE = 95.0;
    private static final double MIN_EXPECTED_PROPERTIES_PASS_RATE = 95.0;
    private static final double MAX_FORBIDDEN_BEHAVIOR_VIOLATION_RATE = 0.0;
    private static final int MAX_ERRORS = 0;

    public static void main(String[] args) {
        ObjectMapper mapper = new ObjectMapper();
        List<Map<String, Object>> evalResults = new ArrayList<>();

        try {
            // =============================================================
            // ЗАГРУЗКА GOLDEN DATASET
            // =============================================================
            byte[] jsonData = Files.readAllBytes(datasetPath);
            ArrayNode evalCases = (ArrayNode) mapper.readTree(jsonData);

            // =============================================================
            // ГРУППИРОВКА EVAL CASES ПО ИСТОЧНИКУ
            // =============================================================
            Map<String, List<JsonNode>> casesByPage = new LinkedHashMap<>();

            for (JsonNode evalCase : evalCases) {
                JsonNode evalInput = evalCase.get("input");
                String source = evalInput.has("source") ? evalInput.get("source").asText() : "";

                // ИСПРАВЛЕНО: ищем issue_id вместо page_id
                String pageId = evalInput.has("issue_id") ? evalInput.get("issue_id").asText() : "inline";

                String key = source + "_" + pageId;
                casesByPage.computeIfAbsent(key, k -> new ArrayList<>()).add(evalCase);
            }

            // =============================================================
            // ЗАПУСК QA AGENT
            // =============================================================
            for (Map.Entry<String, List<JsonNode>> entry : casesByPage.entrySet()) {
                List<JsonNode> pageEvalCases = entry.getValue();
                JsonNode firstCaseInput = pageEvalCases.get(0).get("input");
                String source = firstCaseInput.get("source").asText();
                String pageId = firstCaseInput.has("issue_id") ? firstCaseInput.get("issue_id").asText() : "inline";
                String requirementsText = firstCaseInput.has("requirements") ? firstCaseInput.get("requirements").asText() : "";

                System.out.println("\n" + "=".repeat(80));
                System.out.println("ЗАПУСК QA AGENT");
                System.out.println("=".repeat(80));
                System.out.println("\nИсточник требований: " + source.toUpperCase());
                System.out.println("Ключ (ID/Page): " + pageId);
                System.out.println("Количество Eval Cases: " + pageEvalCases.size() + "\n");

                // PROMPT ДЛЯ QA AGENT
                String prompt;
                if ("inline".equals(source)) {
                    prompt = "Проанализируй следующие требования:\n" + requirementsText;
                } else {
                    prompt = "Запусти полный флоу для задачи из " + source + " с ID=" + pageId +
                            " Выполни аудит, ОБЯЗАТЕЛЬНО создай задачи в Redmine через @task и ОБЯЗАТЕЛЬНО создай тест-кейсы через @test, затем собери final-report.ВАЖНО: " +
                            "Не проверяй связи (relations) и custom_fields, их отсутствие не является ошибкой.";
                }

                // ЗАПУСК OPENCODE
                ProcessBuilder pb = new ProcessBuilder(
                        "cmd.exe", "/c",
                        "C:\\Users\\User\\AppData\\Roaming\\npm\\opencode.cmd",
                        "run", "--format", "json", "--auto" // Промпт убран из аргументов
                );
                pb.directory(projectPath.toFile());
                pb.redirectErrorStream(true);

                Process process = pb.start();
                StringBuilder textParts = new StringBuilder();

                System.out.println("QA Agent запущен...");

                // ПЕРЕДАЧА ПРОМПТА ЧЕРЕЗ STDIN
                try (OutputStreamWriter writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                    writer.write(prompt);
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

                            if ("text".equals(eventType)) {
                                JsonNode part = event.get("part");
                                if (part != null && part.has("text")) {
                                    textParts.append(part.get("text").asText());
                                }
                            }
                        } catch (Exception e) {
                            System.out.println("Не удалось разобрать строку: [" + line + "]");
                        }
                    }
                }

                boolean finished = process.waitFor(10, TimeUnit.MINUTES);
                if (!finished) {
                    process.destroyForcibly();
                }

                int returnCode = process.exitValue();
                String agentResponse = textParts.toString().trim();

                System.out.println("\nQA AGENT RETURN CODE: " + returnCode);

                // ОБРАБОТКА ОШИБКИ QA AGENT
                if (returnCode != 0 || agentResponse.isEmpty()) {
                    System.out.println("QA Agent завершился с ошибкой или не вернул текст.");
                    for (JsonNode evalCase : pageEvalCases) {
                        Map<String, Object> res = new HashMap<>();
                        res.put("id", evalCase.get("id").asText());
                        res.put("name", evalCase.get("name").asText());
                        res.put("status", "ERROR");
                        res.put("score", 0.0);
                        res.put("expected_properties", new ArrayList<>());
                        res.put("forbidden_behavior", new ArrayList<>());
                        evalResults.add(res);
                    }
                    continue;
                }

                // ВЫВОД ОТВЕТА QA AGENT
                System.out.println("\n" + "=".repeat(80));
                System.out.println("ОТВЕТ QA AGENT");
                System.out.println("=".repeat(80));
                System.out.println(agentResponse);
                System.out.println("=".repeat(80));

                // =============================================================
                // EVALUATION
                // =============================================================
                for (JsonNode evalCase : pageEvalCases) {
                    System.out.println("\n\n" + "-".repeat(80));
                    System.out.println("Evaluation: " + evalCase.get("id").asText());
                    System.out.println("Название: " + evalCase.get("name").asText());
                    System.out.println("-".repeat(80));
                    System.out.println("\nЗапускаем Evaluator...");

                    try {
                        JsonNode evaluationResult = Evaluator.evaluateResponse(evalCase, agentResponse);

                        System.out.println("\n" + "=".repeat(80));
                        System.out.println("РЕЗУЛЬТАТ EVALUATION");
                        System.out.println("=".repeat(80));
                        System.out.println(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(evaluationResult));
                        System.out.println("=".repeat(80));

                        String status = evaluationResult.get("status").asText();
                        double score = evaluationResult.get("score").asDouble();

                        Map<String, Object> res = new HashMap<>();
                        res.put("id", evalCase.get("id").asText());
                        res.put("name", evalCase.get("name").asText());
                        res.put("status", status);
                        res.put("score", score);
                        res.put("expected_properties", mapper.convertValue(evaluationResult.get("expected_properties"), List.class));
                        res.put("forbidden_behavior", mapper.convertValue(evaluationResult.get("forbidden_behavior"), List.class));
                        evalResults.add(res);

                        System.out.println("\nEVAL CASE: " + evalCase.get("id").asText());
                        System.out.println("STATUS: " + status);
                        System.out.println("SCORE: " + score);

                    } catch (Exception e) {
                        System.out.println("\nОшибка Evaluator: " + e.getMessage());
                        Map<String, Object> res = new HashMap<>();
                        res.put("id", evalCase.get("id").asText());
                        res.put("name", evalCase.get("name").asText());
                        res.put("status", "ERROR");
                        res.put("score", 0.0);
                        res.put("expected_properties", new ArrayList<>());
                        res.put("forbidden_behavior", new ArrayList<>());
                        evalResults.add(res);
                    }
                }
            }

            generateSummaryAndSaveResults(evalResults, mapper);

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static void generateSummaryAndSaveResults(List<Map<String, Object>> evalResults, ObjectMapper mapper) throws Exception {
        System.out.println("\n\n" + "=".repeat(80));
        System.out.println("EVALUATION SUMMARY");
        System.out.println("=".repeat(80));

        int total = evalResults.size();
        int passed = 0;
        int failed = 0;
        int errors = 0;

        for (Map<String, Object> res : evalResults) {
            String status = (String) res.get("status");
            if ("PASS".equals(status)) passed++;
            else if ("FAIL".equals(status)) failed++;
            else if ("ERROR".equals(status)) errors++;
        }

        double passRate = total > 0 ? ((double) passed / total) * 100 : 0.0;
        double averageScore = total > 0 ? evalResults.stream().mapToDouble(r -> ((Number) r.get("score")).doubleValue()).sum() / total : 0.0;

        int totalExpectedProperties = 0;
        int passedExpectedProperties = 0;

        for (Map<String, Object> res : evalResults) {
            List<Map<String, Object>> props = (List<Map<String, Object>>) res.get("expected_properties");
            if (props != null) {
                for (Map<String, Object> prop : props) {
                    totalExpectedProperties++;
                    if (Boolean.TRUE.equals(prop.get("passed"))) passedExpectedProperties++;
                }
            }
        }

        double expectedPropertiesPassRate = totalExpectedProperties > 0 ? ((double) passedExpectedProperties / totalExpectedProperties) * 100 : 0.0;

        int totalForbiddenBehaviors = 0;
        int violatedForbiddenBehaviors = 0;

        for (Map<String, Object> res : evalResults) {
            List<Map<String, Object>> behaviors = (List<Map<String, Object>>) res.get("forbidden_behavior");
            if (behaviors != null) {
                for (Map<String, Object> beh : behaviors) {
                    totalForbiddenBehaviors++;
                    if (Boolean.TRUE.equals(beh.get("violated"))) violatedForbiddenBehaviors++;
                }
            }
        }

        double forbiddenBehaviorViolationRate = totalForbiddenBehaviors > 0 ? ((double) violatedForbiddenBehaviors / totalForbiddenBehaviors) * 100 : 0.0;

        System.out.printf("\nTotal:         %d\n", total);
        System.out.printf("Passed:        %d\n", passed);
        System.out.printf("Failed:        %d\n", failed);
        System.out.printf("Errors:        %d\n", errors);
        System.out.printf("Pass Rate:     %.1f%%\n", passRate);
        System.out.printf("Average Score: %.2f\n", averageScore);

        System.out.println("\nQUALITY METRICS");
        System.out.println("-".repeat(80));
        System.out.printf("Expected Properties:                 %d/%d\n", passedExpectedProperties, totalExpectedProperties);
        System.out.printf("Expected Properties Pass Rate:       %.1f%%\n", expectedPropertiesPassRate);
        System.out.printf("Forbidden Behaviors Violated:        %d/%d\n", violatedForbiddenBehaviors, totalForbiddenBehaviors);
        System.out.printf("Forbidden Behavior Violation Rate:   %.1f%%\n", forbiddenBehaviorViolationRate);

        System.out.println("\n" + "-".repeat(80));
        for (Map<String, Object> res : evalResults) {
            System.out.printf("%-10s%-10sScore: %.2f\n", res.get("id"), res.get("status"), ((Number) res.get("score")).doubleValue());
        }
        System.out.println("-".repeat(80));

        boolean passRateGate = passRate >= MIN_PASS_RATE;
        boolean expectedPropertiesGate = expectedPropertiesPassRate >= MIN_EXPECTED_PROPERTIES_PASS_RATE;
        boolean forbiddenBehaviorGate = forbiddenBehaviorViolationRate <= MAX_FORBIDDEN_BEHAVIOR_VIOLATION_RATE;
        boolean errorsGate = errors <= MAX_ERRORS;

        boolean qualityGatePassed = passRateGate && expectedPropertiesGate && forbiddenBehaviorGate && errorsGate;
        String overallStatus = qualityGatePassed ? "PASS" : "FAIL";

        System.out.println("\n" + "=".repeat(80));
        System.out.println("QUALITY GATE");
        System.out.println("=".repeat(80));
        System.out.printf("\nPass Rate >= %.1f%%: %s (actual: %.1f%%)\n", MIN_PASS_RATE, passRateGate ? "PASS" : "FAIL", passRate);
        System.out.printf("Expected Properties >= %.1f%%: %s (actual: %.1f%%)\n", MIN_EXPECTED_PROPERTIES_PASS_RATE, expectedPropertiesGate ? "PASS" : "FAIL", expectedPropertiesPassRate);
        System.out.printf("Forbidden Behavior <= %.1f%%: %s (actual: %.1f%%)\n", MAX_FORBIDDEN_BEHAVIOR_VIOLATION_RATE, forbiddenBehaviorGate ? "PASS" : "FAIL", forbiddenBehaviorViolationRate);
        System.out.printf("Errors <= %d: %s (actual: %d)\n", MAX_ERRORS, errorsGate ? "PASS" : "FAIL", errors);
        System.out.println("\nQUALITY GATE STATUS: " + overallStatus);
        System.out.println("=".repeat(80));

        Path resultsDir = Paths.get("results");
        Files.createDirectories(resultsDir);
        Path resultsFile = resultsDir.resolve("eval_results.json");

        ObjectNode report = mapper.createObjectNode();
        ObjectNode summary = report.putObject("summary");
        summary.put("total", total);
        summary.put("passed", passed);
        summary.put("failed", failed);
        summary.put("errors", errors);
        summary.put("pass_rate", Math.round(passRate * 10.0) / 10.0);
        summary.put("average_score", Math.round(averageScore * 100.0) / 100.0);
        summary.put("expected_properties_pass_rate", Math.round(expectedPropertiesPassRate * 10.0) / 10.0);
        summary.put("forbidden_behavior_violation_rate", Math.round(forbiddenBehaviorViolationRate * 10.0) / 10.0);
        summary.put("overall_status", overallStatus);

        ObjectNode metrics = report.putObject("metrics");
        ObjectNode expectedPropsMetric = metrics.putObject("expected_properties");
        expectedPropsMetric.put("total", totalExpectedProperties);
        expectedPropsMetric.put("passed", passedExpectedProperties);
        expectedPropsMetric.put("pass_rate", Math.round(expectedPropertiesPassRate * 10.0) / 10.0);

        ObjectNode forbiddenMetric = metrics.putObject("forbidden_behavior");
        forbiddenMetric.put("total", totalForbiddenBehaviors);
        forbiddenMetric.put("violated", violatedForbiddenBehaviors);
        forbiddenMetric.put("violation_rate", Math.round(forbiddenBehaviorViolationRate * 10.0) / 10.0);

        ObjectNode qualityGate = report.putObject("quality_gate");
        qualityGate.put("status", overallStatus);
        ObjectNode criteria = qualityGate.putObject("criteria");

        ObjectNode prGate = criteria.putObject("pass_rate");
        prGate.put("threshold", MIN_PASS_RATE);
        prGate.put("actual", Math.round(passRate * 10.0) / 10.0);
        prGate.put("passed", passRateGate);

        ObjectNode epGate = criteria.putObject("expected_properties_pass_rate");
        epGate.put("threshold", MIN_EXPECTED_PROPERTIES_PASS_RATE);
        epGate.put("actual", Math.round(expectedPropertiesPassRate * 10.0) / 10.0);
        epGate.put("passed", expectedPropertiesGate);

        ObjectNode fbGate = criteria.putObject("forbidden_behavior_violation_rate");
        fbGate.put("threshold", MAX_FORBIDDEN_BEHAVIOR_VIOLATION_RATE);
        fbGate.put("actual", Math.round(forbiddenBehaviorViolationRate * 10.0) / 10.0);
        fbGate.put("passed", forbiddenBehaviorGate);

        ObjectNode eGate = criteria.putObject("errors");
        eGate.put("threshold", MAX_ERRORS);
        eGate.put("actual", errors);
        eGate.put("passed", errorsGate);

        report.set("results", mapper.valueToTree(evalResults));

        mapper.writerWithDefaultPrettyPrinter().writeValue(resultsFile.toFile(), report);

        System.out.println("\nРезультаты сохранены: " + resultsFile.toAbsolutePath());
    }
}