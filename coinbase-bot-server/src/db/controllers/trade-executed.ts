import Trade from "../../db/model.ts/Trade";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';


export const tradeExecuted = async () => {
    const { 
        time, 
        symbol, 
        type, 
        trailingMethod, 
        price, 
        entryPrice, 
        exitPrice, 
        contracts, 
        fees, 
        orderId, 
        profitQuote, 
        source, 
        side, 
        siblingId,
    } = req.body;

    try {
        const trade = new Trade({ 
            time, 
            symbol, 
            type, 
            trailingMethod, 
            price, 
            entryPrice, 
            exitPrice, 
            contracts, 
            fees, 
            orderId, 
            profitQuote, 
            source, 
            side,
            siblingId,
        });
        if(siblingId) {
            // find the sibling trade
            const sibling = await Trade.findById(siblingId);
            if(!sibling) {
                console.log(`Sibling trade not found for ID: ${siblingId}- trade either deleted or never existed`);
            }

            trade.siblingId = sibling?._id;
        } else {
            trade.siblingId = new mongoose.Types.ObjectId();
        }
       
        await trade.save();
        res.status(200).json({ message: "Trade executed successfully" });
    } catch(err) {
        res.status(500).json({ message: "Error executing trade", error: err });
    }
}