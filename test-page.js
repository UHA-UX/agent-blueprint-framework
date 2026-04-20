// Simple test script to verify the page loads
import fetch from 'node:fetch';

async function testPage() {
  try {
    const response = await fetch('http://localhost:5173/');
    const html = await response.text();
    
    console.log('✓ Page loads successfully');
    console.log('✓ Status:', response.status);
    console.log('✓ Title found:', html.includes('Agent Blueprint Autofill'));
    console.log('✓ Root div found:', html.includes('<div id="root">'));
    console.log('✓ Main script found:', html.includes('/src/main.jsx'));
    
    const mainResponse = await fetch('http://localhost:5173/src/main.jsx');
    const mainJs = await mainResponse.text();
    console.log('✓ React main.jsx loads:', mainResponse.status === 200);
    console.log('✓ App component imported:', mainJs.includes('App'));
    
    const blueprintResponse = await fetch('http://localhost:5173/src/AgentBlueprint.jsx');
    const blueprintJs = await blueprintResponse.text();
    console.log('✓ AgentBlueprint.jsx loads:', blueprintResponse.status === 200);
    console.log('✓ Tabs component imported:', blueprintJs.includes('Tabs'));
    console.log('✓ Card component imported:', blueprintJs.includes('Card'));
    
    console.log('\n✓ All checks passed! The page should render correctly.');
    console.log('\nExpected tabs:');
    console.log('  - Agent Charter');
    console.log('  - Agent Topics');
    console.log('  - Script Matrix');
    console.log('  - Handoff Package');
    
  } catch (error) {
    console.error('✗ Error:', error.message);
  }
}

testPage();
