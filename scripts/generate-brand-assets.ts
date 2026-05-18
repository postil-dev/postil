import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const brandDir = path.join(process.cwd(), 'brand');
const logoMarkPath = path.join(brandDir, 'logo-mark.svg');
const avatarDestPath = path.join(brandDir, 'avatar.png');
const faviconDestPath = path.join(process.cwd(), 'public', 'favicon.ico');

async function generate() {
    console.log('Generating brand assets from logo-mark.svg...');
    
    if (!fs.existsSync(logoMarkPath)) {
        console.error('Error: logo-mark.svg not found in /brand');
        process.exit(1);
    }
    
    // Generate avatar (280x280 PNG)
    await sharp(logoMarkPath)
        .resize(280, 280)
        .png()
        .toFile(avatarDestPath);
    console.log('Generated brand/avatar.png (280x280)');

    // Generate smaller icon as fallback if we want to copy it to public etc.
    // For NextJS app router, a favicon.ico is standard fallback although icon.svg works too.
    // Since icon.svg is the preferred way in Next 14/15, we'll ensure public/icon.svg is updated.
    
    // Read the primary logo mark
    const logoMarkContent = fs.readFileSync(logoMarkPath, 'utf8');
    
    // We update brand/avatar.svg and brand/favicon.svg to be identical to logo-mark.svg 
    // to maintain a Single Source of Truth as stated in the acceptance criteria
    fs.writeFileSync(path.join(brandDir, 'avatar.svg'), logoMarkContent);
    fs.writeFileSync(path.join(brandDir, 'favicon.svg'), logoMarkContent);
    console.log('Synchronized brand/avatar.svg and brand/favicon.svg with brand/logo-mark.svg');
    
    // Make sure public/icon.svg is the same
    const publicDir = path.join(process.cwd(), 'public');
    if (fs.existsSync(publicDir)) {
        const publicIconPath = path.join(publicDir, 'icon.svg');
        fs.writeFileSync(publicIconPath, logoMarkContent);
        console.log('Synchronized public/icon.svg with brand/logo-mark.svg');
    }
}

generate().catch(console.error);
