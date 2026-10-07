import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Long-running compiler process. Reads one request per line from stdin and writes
 * one response per line to stdout. Groovy is loaded from the project classpath
 * (not from this process) so the diagnostics match the project's compiler.
 *
 * Compilation stops at CLASS_GENERATION, which is where Groovy reports the last
 * structural errors, and before OUTPUT, which is the phase that writes .class files.
 */
public final class CompilerDaemon {
	static final String PREFIX = "CODE_GROOVY_DIAG:";

	public static void main(String[] args) throws Exception {
		BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		String line;
		while ((line = reader.readLine()) != null) {
			int marker = line.indexOf(PREFIX);
			if (marker < 0) {
				continue;
			}
			String json = line.substring(marker + PREFIX.length()).trim();
			String response;
			try {
				response = handle(json);
			} catch (Throwable error) {
				response = errorResponse(null, rootMessage(error));
			}
			System.out.println(PREFIX + response);
			System.out.flush();
		}
	}

	static String handle(String json) {
		String id = null;
		try {
			Map<String, Object> request = Json.parseObject(json);
			id = request.get("id") == null ? null : String.valueOf(request.get("id"));
			String source = request.get("source") instanceof String ? (String) request.get("source") : null;
			String path = request.get("path") instanceof String ? (String) request.get("path") : "Script.groovy";
			if (source == null) {
				return errorResponse(id, "Missing source");
			}
			List<Map<String, Object>> diagnostics = compile(path, source, stringList(request.get("classpath")));
			return diagnosticsResponse(id, diagnostics);
		} catch (Throwable error) {
			return errorResponse(id, rootMessage(error));
		}
	}

	private static List<Map<String, Object>> compile(String path, String source, List<String> classpath) throws Exception {
		List<URL> urls = new ArrayList<URL>();
		for (String entry : classpath) {
			if (entry == null || entry.isEmpty()) {
				continue;
			}
			java.io.File file = new java.io.File(entry);
			if (!file.exists()) {
				continue;
			}
			urls.add(file.toURI().toURL());
		}

		URLClassLoader loader = new URLClassLoader(urls.toArray(new URL[urls.size()]), CompilerDaemon.class.getClassLoader());
		ClassLoader previous = Thread.currentThread().getContextClassLoader();
		Thread.currentThread().setContextClassLoader(loader);
		Object groovyLoader = null;
		try {
			Class<?> configClass = Class.forName("org.codehaus.groovy.control.CompilerConfiguration", true, loader);
			Object config = configClass.getDeclaredConstructor().newInstance();
			invokeIfPresent(config, "setSourceEncoding", new Class<?>[] { String.class }, new Object[] { "UTF-8" });
			invokeIfPresent(config, "setTolerance", new Class<?>[] { int.class }, new Object[] { Integer.valueOf(100) });

			Class<?> groovyLoaderClass = Class.forName("groovy.lang.GroovyClassLoader", true, loader);
			groovyLoader = groovyLoaderClass
				.getConstructor(ClassLoader.class, configClass)
				.newInstance(loader, config);

			Class<?> unitClass = Class.forName("org.codehaus.groovy.control.CompilationUnit", true, loader);
			Object unit = unitClass
				.getConstructor(configClass, CodeSource.class, groovyLoaderClass)
				.newInstance(config, null, groovyLoader);

			String name = path.endsWith(".groovy") ? path : path + ".groovy";
			unitClass.getMethod("addSource", String.class, String.class).invoke(unit, name, source);

			int throughPhase = 7;
			try {
				Class<?> phases = Class.forName("org.codehaus.groovy.control.Phases", true, loader);
				throughPhase = phases.getField("CLASS_GENERATION").getInt(null);
			} catch (ClassNotFoundException ignored) {
				// Groovy has used 7 for CLASS_GENERATION since 1.x.
			}

			Throwable compilationFailure = null;
			try {
				unitClass.getMethod("compile", int.class).invoke(unit, Integer.valueOf(throughPhase));
			} catch (InvocationTargetException failed) {
				Throwable cause = failed.getCause() == null ? failed : failed.getCause();
				if (!isCompilationFailure(cause)) {
					if (cause instanceof Exception) {
						throw (Exception) cause;
					}
					throw new Exception(cause);
				}
				compilationFailure = cause;
			}
			List<Map<String, Object>> diagnostics = readDiagnostics(unit);
			if (diagnostics.isEmpty() && compilationFailure != null) {
				diagnostics.add(fallbackDiagnostic(rootMessage(compilationFailure)));
			}
			return diagnostics;
		} catch (ClassNotFoundException missing) {
			throw new CompilerUnavailableException("Groovy compiler was not found on the project classpath");
		} finally {
			Thread.currentThread().setContextClassLoader(previous);
			closeQuietly(groovyLoader);
			closeQuietly(loader);
		}
	}

	private static boolean isCompilationFailure(Throwable cause) {
		if (cause == null) {
			return false;
		}
		String name = cause.getClass().getName();
		return name.endsWith("CompilationFailedException") || name.endsWith("MultipleCompilationErrorsException");
	}

	@SuppressWarnings("unchecked")
	private static List<Map<String, Object>> readDiagnostics(Object unit) throws Exception {
		Object collector = unit.getClass().getMethod("getErrorCollector").invoke(unit);
		Object rawErrors = collector.getClass().getMethod("getErrors").invoke(collector);
		List<Map<String, Object>> diagnostics = new ArrayList<Map<String, Object>>();
		if (!(rawErrors instanceof List)) {
			return diagnostics;
		}
		List<Object> seen = new ArrayList<Object>();
		for (Object message : (List<Object>) rawErrors) {
			if (message == null) {
				continue;
			}
			Map<String, Object> diagnostic = toDiagnostic(message);
			String key = diagnostic.get("line") + ":" + diagnostic.get("column") + ":" + diagnostic.get("message");
			if (seen.contains(key)) {
				continue;
			}
			seen.add(key);
			diagnostics.add(diagnostic);
		}
		return dropCompilerCrashes(diagnostics);
	}

	private static Map<String, Object> toDiagnostic(Object message) throws Exception {
		int line = 0;
		int column = 0;
		int endLine = 0;
		int endColumn = 0;
		String text = null;
		Object located = findLocated(message);
		if (located != null) {
			int[] where = readLocation(located);
			if (where != null) {
				line = where[0];
				column = where[1];
				endLine = where[2];
				endColumn = where[3];
			}
			Object withoutLocation = invokeIfPresent(located, "getMessageWithoutLocationText", new Class<?>[0], new Object[0]);
			if (withoutLocation instanceof String && !((String) withoutLocation).trim().isEmpty()) {
				text = (String) withoutLocation;
			} else if (located instanceof Throwable) {
				text = ((Throwable) located).getMessage();
			} else {
				text = String.valueOf(located);
			}
		}
		if (text == null || text.trim().isEmpty()) {
			StringWriter writer = new StringWriter();
			PrintWriter printer = new PrintWriter(writer);
			try {
				message.getClass().getMethod("write", PrintWriter.class).invoke(message, printer);
				printer.flush();
				text = writer.toString();
			} catch (ReflectiveOperationException ignored) {
				text = String.valueOf(message);
			}
		}
		text = unwrapCompilerCrash(text);
		if (line <= 0) {
			int[] parsed = lineFromLocationText(text);
			if (parsed != null) {
				line = parsed[0];
				column = parsed[1];
			}
		}
		Map<String, Object> diagnostic = new LinkedHashMap<String, Object>();
		diagnostic.put("message", clean(text));
		diagnostic.put("severity", "error");
		diagnostic.put("line", Integer.valueOf(line));
		diagnostic.put("column", Integer.valueOf(column));
		diagnostic.put("endLine", Integer.valueOf(endLine));
		diagnostic.put("endColumn", Integer.valueOf(endColumn));
		return diagnostic;
	}

	private static Map<String, Object> fallbackDiagnostic(String message) {
		Map<String, Object> diagnostic = new LinkedHashMap<String, Object>();
		diagnostic.put("message", message);
		diagnostic.put("severity", "error");
		diagnostic.put("line", Integer.valueOf(1));
		diagnostic.put("column", Integer.valueOf(1));
		diagnostic.put("endLine", Integer.valueOf(1));
		diagnostic.put("endColumn", Integer.valueOf(1));
		return diagnostic;
	}

	private static List<Map<String, Object>> dropCompilerCrashes(List<Map<String, Object>> diagnostics) {
		boolean located = false;
		for (Map<String, Object> diagnostic : diagnostics) {
			if (intValue(diagnostic.get("line")) > 0 && !isCompilerCrash(String.valueOf(diagnostic.get("message")))) {
				located = true;
				break;
			}
		}
		if (!located) {
			return diagnostics;
		}
		List<Map<String, Object>> kept = new ArrayList<Map<String, Object>>();
		for (Map<String, Object> diagnostic : diagnostics) {
			if (!isCompilerCrash(String.valueOf(diagnostic.get("message")))) {
				kept.add(diagnostic);
			}
		}
		return kept;
	}

	private static boolean isCompilerCrash(String message) {
		return message.startsWith("General error during")
			|| message.startsWith("BUG! exception in phase")
			|| message.contains("cannot be cast to");
	}

	private static String unwrapCompilerCrash(String message) {
		if (message == null || !isCompilerCrash(message.trim())) {
			return message;
		}
		int separator = message.indexOf(": ");
		if (separator < 0) {
			return message;
		}
		return message.substring(separator + 2);
	}

	/** The user-facing SyntaxException is often wrapped in a compiler crash. */
	private static Object findLocated(Object start) {
		Object current = start;
		Object found = null;
		for (int depth = 0; current != null && depth < 8; depth++) {
			if (readLocation(current) != null) {
				found = current;
			}
			Object next = current instanceof Throwable ? ((Throwable) current).getCause() : null;
			if (next == null) {
				next = invokeIfPresent(current, "getCause", new Class<?>[0], new Object[0]);
			}
			if (!(next instanceof Throwable) || next == current) {
				break;
			}
			current = next;
		}
		return found;
	}

	private static int[] readLocation(Object target) {
		int line = firstPositive(target, "getStartLine", "getLine");
		int column = firstPositive(target, "getStartColumn", "getColumn");
		int endLine = firstPositive(target, "getEndLine", "getLastLine");
		int endColumn = firstPositive(target, "getEndColumn", "getLastColumn");
		if (line <= 0) {
			Object node = invokeIfPresent(target, "getNode", new Class<?>[0], new Object[0]);
			if (node != null) {
				line = firstPositive(node, "getLine", "getStartLine");
				column = firstPositive(node, "getColumn", "getStartColumn");
				endLine = firstPositive(node, "getLastLine", "getEndLine");
				endColumn = firstPositive(node, "getLastColumn", "getEndColumn");
			}
		}
		if (line <= 0) {
			return null;
		}
		return new int[] { line, column, endLine, endColumn };
	}

	/** RuntimeParserException prints the span as `. At [line:column]`. */
	private static int[] lineFromLocationText(String message) {
		if (message == null) {
			return null;
		}
		java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("At \\[(\\d+):(\\d+)\\]").matcher(message);
		if (!matcher.find()) {
			return null;
		}
		return new int[] { Integer.parseInt(matcher.group(1)), Integer.parseInt(matcher.group(2)) };
	}

	private static int firstPositive(Object target, String primary, String fallback) {
		int value = intValue(invokeIfPresent(target, primary, new Class<?>[0], new Object[0]));
		if (value > 0) {
			return value;
		}
		return intValue(invokeIfPresent(target, fallback, new Class<?>[0], new Object[0]));
	}

	private static String clean(String message) {
		if (message == null) {
			return "Compilation failed";
		}
		String trimmed = message.trim();
		int newline = trimmed.indexOf('\n');
		if (newline >= 0) {
			trimmed = trimmed.substring(0, newline).trim();
		}
		trimmed = trimmed.replaceAll("\\s*@ line \\d+, column \\d+\\.?$", "");
		if (trimmed.length() > 500) {
			return trimmed.substring(0, 500);
		}
		return trimmed.isEmpty() ? "Compilation failed" : trimmed;
	}

	private static int intValue(Object value) {
		return value instanceof Number ? ((Number) value).intValue() : 0;
	}

	private static Object invokeIfPresent(Object target, String name, Class<?>[] types, Object[] args) {
		try {
			Method method = target.getClass().getMethod(name, types);
			return method.invoke(target, args);
		} catch (ReflectiveOperationException ignored) {
			return null;
		}
	}

	private static void closeQuietly(Object closeable) {
		if (closeable == null) {
			return;
		}
		try {
			closeable.getClass().getMethod("close").invoke(closeable);
		} catch (ReflectiveOperationException ignored) {
			// URLClassLoader.close exists since Java 7; ignore loaders that cannot close.
		}
	}

	@SuppressWarnings("unchecked")
	private static List<String> stringList(Object value) {
		List<String> entries = new ArrayList<String>();
		if (!(value instanceof List)) {
			return entries;
		}
		for (Object item : (List<Object>) value) {
			if (item != null) {
				entries.add(String.valueOf(item));
			}
		}
		return entries;
	}

	private static String rootMessage(Throwable error) {
		Throwable current = error;
		while (current.getCause() != null && current.getCause() != current) {
			current = current.getCause();
		}
		String message = current.getMessage();
		if (message == null || message.trim().isEmpty()) {
			return current.getClass().getName();
		}
		return clean(message);
	}

	private static String errorResponse(String id, String message) {
		Map<String, Object> response = new LinkedHashMap<String, Object>();
		response.put("id", id);
		response.put("error", message == null ? "Compilation failed" : message);
		return Json.write(response);
	}

	private static String diagnosticsResponse(String id, List<Map<String, Object>> diagnostics) {
		Map<String, Object> response = new LinkedHashMap<String, Object>();
		response.put("id", id);
		response.put("diagnostics", diagnostics);
		return Json.write(response);
	}

	private static final class CompilerUnavailableException extends Exception {
		CompilerUnavailableException(String message) {
			super(message);
		}
	}

	/** JSON object/array/string codec for the stdin protocol. */
	static final class Json {
		private final String text;
		private int index;

		private Json(String text) {
			this.text = text;
			this.index = 0;
		}

		static Map<String, Object> parseObject(String text) {
			Json parser = new Json(text);
			Map<String, Object> value = parser.readObject();
			parser.skip();
			if (parser.index != parser.text.length()) {
				throw new IllegalArgumentException("Trailing data in compiler request");
			}
			return value;
		}

		static String write(Object value) {
			StringBuilder out = new StringBuilder();
			writeValue(out, value);
			return out.toString();
		}

		@SuppressWarnings("unchecked")
		private static void writeValue(StringBuilder out, Object value) {
			if (value == null) {
				out.append("null");
			} else if (value instanceof String) {
				writeString(out, (String) value);
			} else if (value instanceof Number || value instanceof Boolean) {
				out.append(String.valueOf(value));
			} else if (value instanceof Map) {
				out.append('{');
				boolean first = true;
				for (Map.Entry<String, Object> entry : ((Map<String, Object>) value).entrySet()) {
					if (!first) {
						out.append(',');
					}
					first = false;
					writeString(out, entry.getKey());
					out.append(':');
					writeValue(out, entry.getValue());
				}
				out.append('}');
			} else if (value instanceof List) {
				out.append('[');
				boolean first = true;
				for (Object item : (List<Object>) value) {
					if (!first) {
						out.append(',');
					}
					first = false;
					writeValue(out, item);
				}
				out.append(']');
			} else {
				writeString(out, String.valueOf(value));
			}
		}

		private static void writeString(StringBuilder out, String value) {
			out.append('"');
			for (int i = 0; i < value.length(); i++) {
				char current = value.charAt(i);
				switch (current) {
					case '"':
						out.append("\\\"");
						break;
					case '\\':
						out.append("\\\\");
						break;
					case '\b':
						out.append("\\b");
						break;
					case '\f':
						out.append("\\f");
						break;
					case '\n':
						out.append("\\n");
						break;
					case '\r':
						out.append("\\r");
						break;
					case '\t':
						out.append("\\t");
						break;
					default:
						if (current < 0x20) {
							out.append(String.format(Locale.ROOT, "\\u%04x", Integer.valueOf(current)));
						} else {
							out.append(current);
						}
				}
			}
			out.append('"');
		}

		private Map<String, Object> readObject() {
			skip();
			expect('{');
			Map<String, Object> object = new LinkedHashMap<String, Object>();
			skip();
			if (peek('}')) {
				index++;
				return object;
			}
			while (true) {
				skip();
				String key = readString();
				skip();
				expect(':');
				object.put(key, readValue());
				skip();
				if (peek('}')) {
					index++;
					return object;
				}
				expect(',');
			}
		}

		private Object readValue() {
			skip();
			if (index >= text.length()) {
				throw new IllegalArgumentException("Unexpected end of compiler request");
			}
			char current = text.charAt(index);
			if (current == '"') {
				return readString();
			}
			if (current == '{') {
				return readObject();
			}
			if (current == '[') {
				return readArray();
			}
			if (text.startsWith("true", index)) {
				index += 4;
				return Boolean.TRUE;
			}
			if (text.startsWith("false", index)) {
				index += 5;
				return Boolean.FALSE;
			}
			if (text.startsWith("null", index)) {
				index += 4;
				return null;
			}
			return readNumber();
		}

		private List<Object> readArray() {
			expect('[');
			List<Object> values = new ArrayList<Object>();
			skip();
			if (peek(']')) {
				index++;
				return values;
			}
			while (true) {
				values.add(readValue());
				skip();
				if (peek(']')) {
					index++;
					return values;
				}
				expect(',');
			}
		}

		private String readString() {
			expect('"');
			StringBuilder out = new StringBuilder();
			while (index < text.length()) {
				char current = text.charAt(index++);
				if (current == '"') {
					return out.toString();
				}
				if (current != '\\') {
					out.append(current);
					continue;
				}
				if (index >= text.length()) {
					throw new IllegalArgumentException("Truncated string escape");
				}
				char escaped = text.charAt(index++);
				switch (escaped) {
					case '"':
					case '\\':
					case '/':
						out.append(escaped);
						break;
					case 'b':
						out.append('\b');
						break;
					case 'f':
						out.append('\f');
						break;
					case 'n':
						out.append('\n');
						break;
					case 'r':
						out.append('\r');
						break;
					case 't':
						out.append('\t');
						break;
					case 'u':
						if (index + 4 > text.length()) {
							throw new IllegalArgumentException("Truncated unicode escape");
						}
						int code = Integer.parseInt(text.substring(index, index + 4), 16);
						index += 4;
						out.append((char) code);
						break;
					default:
						throw new IllegalArgumentException("Bad string escape");
				}
			}
			throw new IllegalArgumentException("Unterminated string");
		}

		private Number readNumber() {
			int start = index;
			if (peek('-')) {
				index++;
			}
			while (index < text.length() && Character.isDigit(text.charAt(index))) {
				index++;
			}
			boolean fractional = false;
			if (peek('.')) {
				fractional = true;
				index++;
				while (index < text.length() && Character.isDigit(text.charAt(index))) {
					index++;
				}
			}
			if (index < text.length() && (text.charAt(index) == 'e' || text.charAt(index) == 'E')) {
				fractional = true;
				index++;
				if (peek('+') || peek('-')) {
					index++;
				}
				while (index < text.length() && Character.isDigit(text.charAt(index))) {
					index++;
				}
			}
			String literal = text.substring(start, index);
			if (fractional) {
				return Double.valueOf(literal);
			}
			return Long.valueOf(literal);
		}

		private void skip() {
			while (index < text.length() && text.charAt(index) <= ' ') {
				index++;
			}
		}

		private boolean peek(char expected) {
			return index < text.length() && text.charAt(index) == expected;
		}

		private void expect(char expected) {
			skip();
			if (!peek(expected)) {
				throw new IllegalArgumentException("Expected '" + expected + "' in compiler request");
			}
			index++;
		}
	}
}
