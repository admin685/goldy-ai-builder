import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import buildRouter from "./build.js";
import importRouter from "./import.js";
import authRouter from "./auth.js";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(buildRouter);
router.use(importRouter);

export default router;
