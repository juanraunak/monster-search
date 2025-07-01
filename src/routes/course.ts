import { FastifyPluginAsync } from "fastify";
import { runIntentAgent, runCourseAgent } from "../spider";

const courseRoute: FastifyPluginAsync = async (fastify) => {
  // 🔹 Route 1: Chat with Intent Agent
  fastify.post("/chat", async (request, reply) => {
    const { sessionId, message } = request.body as {
      sessionId: string;
      message: string;
    };

    if (!sessionId || !message) {
      reply.status(400).send({ success: false, error: "Missing sessionId or message" });
      return;
    }

    try {
      const result = await runIntentAgent(sessionId, message);
      reply.send({ success: true, ...result });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // 🔹 Route 2: Run Full Course Generation
  fastify.post("/spider", async (request, reply) => {
    const { topic, intent } = request.body as {
      topic: string;
      intent: string;
    };

    if (!topic || !intent) {
      reply.status(400).send({ success: false, error: "Missing topic or intent" });
      return;
    }

    const result = await runCourseAgent(topic, intent);
    reply.send(result);
  });
};

export default courseRoute;
