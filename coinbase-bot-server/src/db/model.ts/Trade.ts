import mongoose from "mongoose";

export interface ITrade extends mongoose.Document {
   time: Date;
   symbol: string;
   type: "spot" | "futures";
   trailingMethod: "flip-naked" | "flip-profit-bound" | "naked-spot";
   price: number;
   entryPrice: number;
   exitPrice?: number;
   contracts: number;
   fees: number;
   orderId: string;
   profitQuote?: number;
   source: string;
   side: "buy" | "sell";
}

const tradeSchema = new mongoose.Schema<ITrade>({
    time: { type: Date, required: true },
    symbol: { type: String, required: true },
    type: { type: String, required: true, enum: ["spot", "futures"] },
    trailingMethod: { type: String, required: true, enum: ["flip-naked", "flip-profit-bound", "naked-spot"] },
    price: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number },
    contracts: { type: Number, required: true },
    fees: { type: Number, required: true },
    orderId: { type: String, required: true },
    profitQuote: { type: Number },
    source: { type: String, required: true },
    side: { type: String, required: true, enum: ["buy", "sell"] },
}, { timestamps: true });

export default mongoose.models.Trade || mongoose.model<ITrade>("Trade", tradeSchema);