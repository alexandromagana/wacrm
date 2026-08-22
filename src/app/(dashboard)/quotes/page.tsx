'use client';

import { useEffect, useState } from 'react';
import { Calculator, FileText, SlidersHorizontal, Sparkles } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { GeneratePanel } from '@/components/quotes/generate-panel';
import { ProjectTypesPanel } from '@/components/quotes/project-types-panel';
import { TemplatesPanel } from '@/components/quotes/templates-panel';

type Tab = 'generate' | 'rules' | 'templates';

export default function QuotesPage() {
  const [tab, setTab] = useState<Tab>('generate');
  const [decided, setDecided] = useState(false);

  // A generator with no template can't produce anything, so send a
  // first-time account to Plantillas instead of a dead Generar tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/quotes/templates');
        const data = await res.json().catch(() => ({}));
        const count = Array.isArray(data?.templates) ? data.templates.length : 0;
        if (!cancelled) setTab(count > 0 ? 'generate' : 'templates');
      } catch {
        if (!cancelled) setTab('generate');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Calculator className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Cotizador
        </h1>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Genera una cotización a partir del recibo CFE del cliente, para
        cualquier tipo de proyecto, no solo los que cotiza el bot.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="generate">
              <Sparkles className="mr-1.5 h-4 w-4" /> Generar
            </TabsTrigger>
            <TabsTrigger value="rules">
              <SlidersHorizontal className="mr-1.5 h-4 w-4" /> Reglas de cálculo
            </TabsTrigger>
            <TabsTrigger value="templates">
              <FileText className="mr-1.5 h-4 w-4" /> Plantillas
            </TabsTrigger>
          </TabsList>

          <TabsContent value="generate" className="mt-4">
            <GeneratePanel
              onGoToRules={() => setTab('rules')}
              onGoToTemplates={() => setTab('templates')}
            />
          </TabsContent>

          <TabsContent value="rules" className="mt-4">
            <ProjectTypesPanel />
          </TabsContent>

          <TabsContent value="templates" className="mt-4">
            <TemplatesPanel />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
