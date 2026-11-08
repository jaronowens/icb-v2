import { MediaNode } from "../entity/mediaNode";
import { getMedia } from "../repository/media"


const getMediaNodes = async (db) => {
    
    const rows = await getMedia(db);
    
    const resultRows: MediaNode[] = [];
    for (const row of rows) {
        const newNode: MediaNode = {
            id: row.id,
            name: row.name,
            width: 0,
            height: 0,
            extension: row.extension,
            is_video: row.is_video,
            source: row.source,
            tags: row.tags,
            imageURL: row.imageURL,
            imageHash: row.imageHash,
            previewURL: row.previewURL
        }
        resultRows.push(newNode);
    }
    return resultRows;

}

export {getMediaNodes};