import Trade, { type ITrade } from "../../db/model.ts/Trade";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';


export const tradeExecuted = async (trade: ITrade) => {

    try {
        const tradeData = new Trade(trade);
       
        await tradeData.save();
    } catch(err) {
        console.error(`Error executing trade: ${err}`);
    }
}