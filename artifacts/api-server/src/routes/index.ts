import { Router, type IRouter } from "express";
import healthRouter from "./health";
import buildRouter from "./build";

const router: IRouter = Router();

router.use(healthRouter);
router.use(buildRouter);

export default router;
